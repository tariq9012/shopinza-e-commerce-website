const express = require('express');
const mongoose = require('mongoose');
const Review = require('../models/Review');
const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const MAX_COMMENT_LENGTH = 2000;

/**
 * Review photos must be images WE uploaded to Cloudinary (https://res.cloudinary.com/...).
 * The client used to be able to send any string here, which was then rendered into every
 * visitor's product page (stored XSS). Anything else is dropped.
 */
function sanitizeReviewImages(images) {
    if (!Array.isArray(images)) return [];
    return images
        .filter((url) => {
            if (typeof url !== 'string' || url.length > 500) return false;
            try {
                const parsed = new URL(url);
                return parsed.protocol === 'https:' && parsed.hostname === 'res.cloudinary.com';
            } catch (_err) {
                return false;
            }
        })
        .slice(0, 4);
}

// order statuses that count as "this customer actually received the product"
const PURCHASED_STATUSES = ['paid', 'shipped', 'delivered'];

/** Recomputes a product's rating average + review count from its Review documents. */
async function recalcProductRating(productId, session) {
    const [agg] = await Review.aggregate([
        { $match: { product: productId } },
        { $group: { _id: null, avgRating: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]).session(session || null);

    await Product.findByIdAndUpdate(
        productId,
        {
            rating: agg ? Math.round(agg.avgRating * 10) / 10 : 0,
            reviewCount: agg ? agg.count : 0,
        },
        { session }
    );
}

async function userHasPurchased(userId, productSlug, session) {
    const query = Order.exists({
        user: userId,
        status: { $in: PURCHASED_STATUSES },
        items: { $elemMatch: { productId: productSlug } },
    });
    if (session) query.session(session);
    return Boolean(await query);
}

// GET /api/reviews/:slug  - public list of reviews for a product, newest first
router.get('/:slug', async (req, res) => {
    try {
        const product = await Product.findOne({ slug: req.params.slug });
        if (!product) return res.status(404).json({ message: 'Product not found.' });

        const reviews = await Review.find({ product: product._id })
            .sort({ createdAt: -1 })
            .populate('user', 'firstName lastName');

        res.json({ reviews });
    } catch (err) {
        console.error('Get reviews error:', err);
        res.status(500).json({ message: 'Could not load reviews.' });
    }
});

// GET /api/reviews/:slug/can-review  - eligibility check for the signed-in user
// (bought it? already reviewed it?) so the frontend knows whether to show the form.
router.get('/:slug/can-review', requireAuth, async (req, res) => {
    try {
        const product = await Product.findOne({ slug: req.params.slug });
        if (!product) return res.status(404).json({ message: 'Product not found.' });

        const hasPurchased = await userHasPurchased(req.userId, product.slug);
        const existingReview = await Review.findOne({ product: product._id, user: req.userId });

        res.json({
            canReview: hasPurchased && !existingReview,
            hasPurchased,
            alreadyReviewed: Boolean(existingReview),
        });
    } catch (err) {
        console.error('Can-review check error:', err);
        res.status(500).json({ message: 'Could not check review eligibility.' });
    }
});

// POST /api/reviews  - create a review (verified purchase required, one per product)
router.post('/', requireAuth, async (req, res) => {
    const { productSlug, rating, comment, images } = req.body || {};

    if (typeof productSlug !== 'string' || rating === undefined || typeof comment !== 'string' || !comment.trim()) {
        return res.status(400).json({ message: 'Product, rating, and comment are required.' });
    }
    if (comment.length > MAX_COMMENT_LENGTH) {
        return res.status(400).json({ message: `Your review is too long (max ${MAX_COMMENT_LENGTH} characters).` });
    }

    const numericRating = Number(rating);
    if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
        return res.status(400).json({ message: 'Rating must be a whole number between 1 and 5.' });
    }

    const session = await mongoose.startSession();

    try {
        let review;

        await session.withTransaction(async () => {
            const product = await Product.findOne({ slug: productSlug }).session(session);
            if (!product) {
                const notFound = new Error('Product not found.');
                notFound.status = 404;
                throw notFound;
            }

            const hasPurchased = await userHasPurchased(req.userId, product.slug, session);
            if (!hasPurchased) {
                const notPurchased = new Error('You can only review products you have purchased.');
                notPurchased.status = 403;
                throw notPurchased;
            }

            const existing = await Review.findOne({ product: product._id, user: req.userId }).session(session);
            if (existing) {
                const duplicate = new Error(
                    'You already reviewed this product. Delete your existing review to leave a new one.'
                );
                duplicate.status = 409;
                throw duplicate;
            }

            const created = await Review.create(
                [
                    {
                        product: product._id,
                        user: req.userId,
                        rating: numericRating,
                        comment: comment.trim(),
                        images: sanitizeReviewImages(images),
                        verifiedPurchase: true,
                    },
                ],
                { session }
            );
            review = created[0];

            await recalcProductRating(product._id, session);
        });

        await review.populate('user', 'firstName lastName');
        res.status(201).json({ review });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        if (err.code === 11000) {
            return res.status(409).json({ message: 'You already reviewed this product.' });
        }
        console.error('Create review error:', err);
        res.status(500).json({ message: 'Could not submit your review.' });
    } finally {
        session.endSession();
    }
});

// PUT /api/reviews/:id  - edit your own review
router.put('/:id', requireAuth, async (req, res) => {
    const { rating, comment, images } = req.body || {};

    if (comment !== undefined && (typeof comment !== 'string' || comment.length > MAX_COMMENT_LENGTH)) {
        return res.status(400).json({ message: 'Your review comment is not valid.' });
    }
    const session = await mongoose.startSession();

    try {
        let review;

        await session.withTransaction(async () => {
            const existing = await Review.findById(req.params.id).session(session);
            if (!existing) {
                const notFound = new Error('Review not found.');
                notFound.status = 404;
                throw notFound;
            }
            if (String(existing.user) !== String(req.userId)) {
                const forbidden = new Error('You can only edit your own review.');
                forbidden.status = 403;
                throw forbidden;
            }

            if (rating !== undefined) {
                const numericRating = Number(rating);
                if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
                    const badRating = new Error('Rating must be a whole number between 1 and 5.');
                    badRating.status = 400;
                    throw badRating;
                }
                existing.rating = numericRating;
            }
            if (comment !== undefined) existing.comment = comment.trim();
            if (images !== undefined) existing.images = sanitizeReviewImages(images);

            await existing.save({ session });
            await recalcProductRating(existing.product, session);
            review = existing;
        });

        await review.populate('user', 'firstName lastName');
        res.json({ review });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        console.error('Update review error:', err);
        res.status(500).json({ message: 'Could not update your review.' });
    } finally {
        session.endSession();
    }
});

// DELETE /api/reviews/:id  - remove your own review (admins can remove any review)
router.delete('/:id', requireAuth, async (req, res) => {
    const session = await mongoose.startSession();

    try {
        await session.withTransaction(async () => {
            const existing = await Review.findById(req.params.id).session(session);
            if (!existing) {
                const notFound = new Error('Review not found.');
                notFound.status = 404;
                throw notFound;
            }

            const isOwner = String(existing.user) === String(req.userId);
            let isAdmin = false;

            if (!isOwner) {
                const requester = await User.findById(req.userId).session(session);
                isAdmin = Boolean(requester && requester.role === 'admin');
            }

            if (!isOwner && !isAdmin) {
                const forbidden = new Error('You can only delete your own review.');
                forbidden.status = 403;
                throw forbidden;
            }

            const productId = existing.product;
            await Review.deleteOne({ _id: existing._id }).session(session);
            await recalcProductRating(productId, session);
        });

        res.json({ message: 'Review deleted.' });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ message: err.message });
        console.error('Delete review error:', err);
        res.status(500).json({ message: 'Could not delete review.' });
    } finally {
        session.endSession();
    }
});

module.exports = router;
