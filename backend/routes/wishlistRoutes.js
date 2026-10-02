const express = require('express');
const Wishlist = require('../models/Wishlist');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/wishlist  - the signed-in user's saved product ids (empty if none yet)
router.get('/', requireAuth, async (req, res) => {
    try {
        const wishlist = await Wishlist.findOne({ user: req.userId });
        res.json({ productIds: wishlist ? wishlist.productIds : [] });
    } catch (err) {
        console.error('Get wishlist error:', err);
        res.status(500).json({ message: 'Could not load your wishlist.' });
    }
});

// PUT /api/wishlist  - body: { productIds }
// Full replace, upserting the wishlist if the user doesn't have one yet.
// Called whenever the local wishlist changes (heart icon toggled), and
// right after login once the guest wishlist + saved wishlist are merged.
router.put('/', requireAuth, async (req, res) => {
    try {
        const productIds = Array.isArray(req.body.productIds) ? req.body.productIds : [];

        const wishlist = await Wishlist.findOneAndUpdate(
            { user: req.userId },
            { productIds },
            { new: true, upsert: true }
        );

        res.json({ productIds: wishlist.productIds });
    } catch (err) {
        console.error('Save wishlist error:', err);
        res.status(500).json({ message: 'Could not save your wishlist.' });
    }
});

module.exports = router;
