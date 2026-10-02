const express = require('express');
const Cart = require('../models/Cart');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// GET /api/cart  - the signed-in user's saved cart (empty items if none yet)
router.get('/', requireAuth, async (req, res) => {
    try {
        const cart = await Cart.findOne({ user: req.userId });
        res.json({ items: cart ? cart.items : [] });
    } catch (err) {
        console.error('Get cart error:', err);
        res.status(500).json({ message: 'Could not load your cart.' });
    }
});

// PUT /api/cart  - body: { items }
// Full replace, upserting the cart if the user doesn't have one yet.
// Called by the frontend whenever the local cart changes (add/remove/qty),
// and right after login once the guest cart + saved cart have been merged.
router.put('/', requireAuth, async (req, res) => {
    try {
        const items = Array.isArray(req.body.items) ? req.body.items : [];

        const cart = await Cart.findOneAndUpdate(
            { user: req.userId },
            { items },
            { new: true, upsert: true }
        );

        res.json({ items: cart.items });
    } catch (err) {
        console.error('Save cart error:', err);
        res.status(500).json({ message: 'Could not save your cart.' });
    }
});

// DELETE /api/cart  - empties the saved cart (e.g. after an order is placed)
router.delete('/', requireAuth, async (req, res) => {
    try {
        await Cart.findOneAndUpdate({ user: req.userId }, { items: [] }, { upsert: true });
        res.json({ items: [] });
    } catch (err) {
        console.error('Clear cart error:', err);
        res.status(500).json({ message: 'Could not clear your cart.' });
    }
});

module.exports = router;
