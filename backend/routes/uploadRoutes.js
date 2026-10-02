const express = require('express');
const cloudinary = require('../config/cloudinary');
const { uploadSingle, uploadGallery, uploadReview, limitRequestBytes } = require('../middleware/upload');
const { uploadSignLimiterFor } = require('../middleware/rateLimits');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const CLOUDINARY_FOLDER = 'shopinza/products';

// Vercel rejects request bodies over ~4.5 MB, so images are uploaded from the BROWSER straight
// to Cloudinary using a short-lived signature made here (the api_secret never leaves the server).
// The old multipart endpoints below still work for small files.
const ALLOWED_FORMATS = 'jpg,jpeg,png,webp,gif';
const SIGN_SCOPES = {
    product: { folder: 'shopinza/products', adminOnly: true },
    review: { folder: 'shopinza/reviews', adminOnly: false },
};

// What is (and is NOT) enforced for direct uploads:
//   enforced BY CLOUDINARY (signed parameters, tampering invalidates the signature): the target folder and
//     the allowed image formats, and the signature only lives for about an hour;
//   enforced by US: who may get a signature (login; admin for product images) and HOW OFTEN (per-user rate limit);
//   NOT enforced server-side: the 10 MB size. Cloudinary's upload API has no per-request size cap we can sign -
//     the browser checks it, and the real ceiling is your Cloudinary plan's own file-size limit.
// POST /api/upload/sign  - body: { scope: 'product' | 'review' }
const signReviewLimiter = uploadSignLimiterFor('review');
const signProductLimiter = uploadSignLimiterFor('product');

router.post('/sign', requireAuth, (req, res, next) => {
    const scopeName = req.body && req.body.scope;
    if (scopeName === 'review') return signReviewLimiter(req, res, next);
    if (scopeName === 'product') return signProductLimiter(req, res, next);
    next();
}, async (req, res, next) => {
    const scope = SIGN_SCOPES[req.body && req.body.scope];
    if (!scope) return res.status(400).json({ message: 'Invalid upload scope.' });

    const proceed = () => {
        if (!process.env.CLOUDINARY_API_SECRET || !process.env.CLOUDINARY_CLOUD_NAME) {
            return res.status(503).json({ message: 'Image uploads are not configured on the server.' });
        }
        const timestamp = Math.floor(Date.now() / 1000);
        const params = { timestamp, folder: scope.folder, allowed_formats: ALLOWED_FORMATS };
        const signature = cloudinary.utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET);

        res.json({
            uploadUrl: `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload`,
            apiKey: process.env.CLOUDINARY_API_KEY,
            ...params,
            signature,
        });
    };

    if (scope.adminOnly) return requireAdmin(req, res, proceed);
    proceed();
});

/** Streams a single file buffer (from multer memoryStorage) up to Cloudinary. */
function uploadBufferToCloudinary(buffer, folder = CLOUDINARY_FOLDER) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder, resource_type: 'image' },
            (err, result) => {
                if (err) return reject(err);
                resolve(result);
            }
        );
        stream.end(buffer);
    });
}

// POST /api/upload  - single image (used for a product's main image)
// form-data field name: "image"
router.post('/', requireAuth, requireAdmin, limitRequestBytes(), uploadSingle.single('image'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No image file was provided.' });
        }

        const result = await uploadBufferToCloudinary(req.file.buffer);
        res.status(201).json({ url: result.secure_url, publicId: result.public_id });
    } catch (err) {
        console.error('Image upload error:', err);
        res.status(500).json({ message: 'Could not upload image. Please try again.' });
    }
});

// POST /api/upload/multiple  - up to 6 images at once (used for the product gallery)
// form-data field name: "images"
router.post('/multiple', requireAuth, requireAdmin, limitRequestBytes(), uploadGallery.array('images', 6), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ message: 'No image files were provided.' });
        }

        const results = await Promise.all(
            req.files.map((file) => uploadBufferToCloudinary(file.buffer))
        );

        res.status(201).json({
            images: results.map((result) => ({ url: result.secure_url, publicId: result.public_id })),
        });
    } catch (err) {
        console.error('Gallery upload error:', err);
        res.status(500).json({ message: 'Could not upload images. Please try again.' });
    }
});

// POST /api/upload/review  - up to 4 images, any signed-in user (used for review photos)
// form-data field name: "images". Not admin-only - any customer can attach photos to a review.
router.post('/review', requireAuth, limitRequestBytes(), uploadReview.array('images', 4), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ message: 'No image files were provided.' });
        }

        const results = await Promise.all(
            req.files.map((file) =>
                uploadBufferToCloudinary(file.buffer, 'shopinza/reviews')
            )
        );

        res.status(201).json({
            images: results.map((result) => ({ url: result.secure_url, publicId: result.public_id })),
        });
    } catch (err) {
        console.error('Review image upload error:', err);
        res.status(500).json({ message: 'Could not upload images. Please try again.' });
    }
});

// Catches multer errors (file too large, wrong type, too many files) so they
// come back as a clean 400 instead of crashing the request.
router.use((err, _req, res, _next) => {
    if (err && err.name === 'MulterError') {
        return res.status(400).json({ message: err.message });
    }
    if (err) {
        return res.status(400).json({ message: err.message || 'Upload failed.' });
    }
    res.status(500).json({ message: 'Something went wrong during upload.' });
});

module.exports = router;
