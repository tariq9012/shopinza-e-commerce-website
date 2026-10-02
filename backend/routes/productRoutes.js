const express = require('express');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function slugify(text) {
    return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// GET /api/products?category=Electronics&sort=price_asc&limit=4
// GET /api/products?search=lamp&page=1&pageSize=12   (paginated + full-text search)
router.get('/', async (req, res) => {
    try {
        const { category, sort, limit, search, page, pageSize, maxPrice, sale, color } = req.query;
        const filter = {};

        // supports one category or several (?category=Electronics,Apparel)
        if (category) {
            const cats = category
                .split(',')
                .map((c) => c.trim())
                .filter(Boolean);
            if (cats.length === 1) filter.category = cats[0];
            else if (cats.length > 1) filter.category = { $in: cats };
        }

        if (maxPrice) filter.price = { $lte: Number(maxPrice) };

        // "on sale" = has an oldPrice that's actually higher than the current price
        if (sale === 'true') filter.$expr = { $gt: ['$oldPrice', '$price'] };

        // Color filter (?color=Black,White) - matches PARTIALLY against each
        // product's color names, since a shop sidebar swatch labeled "Black"
        // should also match a product color named e.g. "Midnight Black".
        if (color) {
            const colorNames = color
                .split(',')
                .map((c) => c.trim())
                .filter(Boolean);
            if (colorNames.length > 0) {
                const escaped = colorNames.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
                filter.colors = { $elemMatch: { name: { $regex: escaped.join('|'), $options: 'i' } } };
            }
        }

        // Full-text search across name/description/category (see the text
        // index on the Product model). Scales far better than the old
        // approach of fetching every product and filtering in the browser.
        if (search) filter.$text = { $search: search };

        let query = Product.find(filter);

        if (search && !sort) {
            // no explicit sort requested while searching -> best match first
            query = query.select({ score: { $meta: 'textScore' } }).sort({ score: { $meta: 'textScore' } });
        } else if (sort === 'price_asc') {
            query = query.sort({ price: 1 });
        } else if (sort === 'price_desc') {
            query = query.sort({ price: -1 });
        } else if (sort === 'latest') {
            query = query.sort({ createdAt: -1 });
        } else if (sort === 'popular') {
            query = query.sort({ rating: -1 });
        }

        // Real pagination only kicks in when the caller explicitly asks for
        // a page. This keeps older callers (admin product table, the "4
        // latest products" home-page widget) working exactly as before,
        // while the shop page now asks for a page and gets one back.
        if (page) {
            const pageNum = Math.max(parseInt(page, 10) || 1, 1);
            const size = Math.min(Math.max(parseInt(pageSize, 10) || 12, 1), 100); // cap page size at 100
            const skip = (pageNum - 1) * size;

            const [products, total] = await Promise.all([
                query.skip(skip).limit(size).exec(),
                Product.countDocuments(filter),
            ]);

            return res.json({
                products,
                total,
                page: pageNum,
                pageSize: size,
                totalPages: Math.max(Math.ceil(total / size), 1),
            });
        }

        if (limit) query = query.limit(parseInt(limit, 10) || 0);

        const products = await query.exec();
        res.json({ products });
    } catch (err) {
        console.error('Get products error:', err);
        res.status(500).json({ message: 'Could not load products.' });
    }
});

// GET /api/products/:slug
router.get('/:slug', async (req, res) => {
    try {
        const product = await Product.findOne({ slug: req.params.slug });
        if (!product) return res.status(404).json({ message: 'Product not found.' });
        res.json({ product });
    } catch (err) {
        res.status(500).json({ message: 'Could not load this product.' });
    }
});

// GET /api/products/:slug/recommendations?limit=8
//
// Two-tier recommendation strategy:
//   1. Collaborative filtering - "customers who bought this also bought" -
//      built from real order history (co-purchase frequency).
//   2. Content-based fallback - same category, best-rated first - fills any
//      remaining slots. This also solves the classic recommender-system
//      "cold start" problem: a brand-new product with zero orders yet still
//      gets sensible recommendations instead of an empty section.
router.get('/:slug/recommendations', async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20);

        const product = await Product.findOne({ slug: req.params.slug });
        if (!product) return res.status(404).json({ message: 'Product not found.' });

        // ---------- Tier 1: collaborative ("frequently bought together") ----------
        // Every past order (paid/shipped/delivered) that included this
        // product tells us what else was in that same cart. Counting how
        // often each OTHER product shows up alongside it, across every such
        // order, gives a genuine "customers who bought this also bought"
        // ranking - not just a guess.
        const coPurchaseCounts = await Order.aggregate([
            { $match: { status: { $in: ['paid', 'shipped', 'delivered'] }, 'items.productId': product.slug } },
            { $unwind: '$items' },
            { $match: { 'items.productId': { $ne: product.slug } } },
            { $group: { _id: '$items.productId', coPurchaseCount: { $sum: 1 } } },
            { $sort: { coPurchaseCount: -1 } },
            { $limit: limit },
        ]);

        const coPurchasedSlugs = coPurchaseCounts.map((row) => row._id);
        const coPurchasedProducts = await Product.find({ slug: { $in: coPurchasedSlugs } });

        // $in doesn't preserve order, so re-sort by the co-purchase ranking above
        const bySlug = new Map(coPurchasedProducts.map((p) => [p.slug, p]));
        const recommendations = coPurchasedSlugs
            .map((slug) => bySlug.get(slug))
            .filter(Boolean)
            .map((p) => ({ ...p.toObject(), recommendationReason: 'frequently_bought_together' }));

        // ---------- Tier 2: content-based fallback (same category) ----------
        if (recommendations.length < limit) {
            const excludeSlugs = [product.slug, ...recommendations.map((p) => p.slug)];
            const sameCategory = await Product.find({
                category: product.category,
                slug: { $nin: excludeSlugs },
            })
                .sort({ rating: -1 })
                .limit(limit - recommendations.length);

            recommendations.push(...sameCategory.map((p) => ({ ...p.toObject(), recommendationReason: 'same_category' })));
        }

        res.json({ recommendations });
    } catch (err) {
        console.error('Get recommendations error:', err);
        res.status(500).json({ message: 'Could not load recommendations.' });
    }
});

/* ============================================================
   Admin-only routes below (require a valid admin JWT token)
   ============================================================ */

// POST /api/products  (create a new product)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { name, description, category, price, oldPrice, image, images, colors, sizes, variants, stock } = req.body;

        if (!name || !category || price === undefined || !image) {
            return res.status(400).json({ message: 'Name, category, price, and image are required.' });
        }

        let slug = slugify(name);
        const existing = await Product.findOne({ slug });
        if (existing) {
            slug = `${slug}-${Date.now().toString().slice(-5)}`;
        }

        const hasVariants = Array.isArray(variants) && variants.length > 0;

        const product = await Product.create({
            slug,
            name,
            description,
            category,
            price,
            oldPrice: oldPrice || undefined,
            image,
            images: images || [],
            colors: colors || [],
            sizes: sizes || [],
            variants: variants || [],
            // when variants exist, `stock` is kept as their sum so every
            // other part of the app that reads `product.stock` directly
            // (shop grid, home cards, admin table) stays accurate without
            // needing to know about variants at all
            stock: hasVariants ? variants.reduce((sum, v) => sum + (v.stock || 0), 0) : stock !== undefined ? stock : 20,
        });

        res.status(201).json({ product });
    } catch (err) {
        console.error('Create product error:', err);
        res.status(500).json({ message: 'Could not create product.' });
    }
});

// PUT /api/products/id/:id  (update an existing product by its Mongo _id)
router.put('/id/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { name, description, category, price, oldPrice, image, images, colors, sizes, variants, stock } = req.body;

        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ message: 'Product not found.' });

        if (name && name !== product.name) {
            product.name = name;
            let slug = slugify(name);
            const existing = await Product.findOne({ slug, _id: { $ne: product._id } });
            product.slug = existing ? `${slug}-${Date.now().toString().slice(-5)}` : slug;
        }

        if (description !== undefined) product.description = description;
        if (category !== undefined) product.category = category;
        if (price !== undefined) product.price = price;
        product.oldPrice = oldPrice || undefined;
        if (image !== undefined) product.image = image;
        if (images !== undefined) product.images = images;
        if (colors !== undefined) product.colors = colors;
        if (sizes !== undefined) product.sizes = sizes;

        if (variants !== undefined) {
            product.variants = variants;
            // keep `stock` in sync with the variant grid (see the same
            // comment in the POST handler above)
            if (variants.length > 0) {
                product.stock = variants.reduce((sum, v) => sum + (v.stock || 0), 0);
            } else if (stock !== undefined) {
                product.stock = stock; // no more variants - fall back to the flat stock field
            }
        } else if (stock !== undefined) {
            product.stock = stock;
        }

        await product.save();
        res.json({ product });
    } catch (err) {
        console.error('Update product error:', err);
        res.status(500).json({ message: 'Could not update product.' });
    }
});

// DELETE /api/products/id/:id
router.delete('/id/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const product = await Product.findByIdAndDelete(req.params.id);
        if (!product) return res.status(404).json({ message: 'Product not found.' });
        res.json({ message: 'Product deleted.' });
    } catch (err) {
        console.error('Delete product error:', err);
        res.status(500).json({ message: 'Could not delete product.' });
    }
});

module.exports = router;