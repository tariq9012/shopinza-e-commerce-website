const express = require('express');
const Order = require('../models/Order');
const { optionalAuth, requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

const SHIPPING_COST = { standard: 0, express: 25 };

// POST /api/orders  (checkout) - works for guests too, but attaches the user if logged in
router.post('/', optionalAuth, async (req, res) => {
    try {
        const { items, shipping, shippingMethod } = req.body;

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ message: 'Your cart is empty.' });
        }

        const requiredShippingFields = ['firstName', 'lastName', 'address', 'city', 'state', 'zip'];
        const missingField = requiredShippingFields.find((field) => !shipping || !shipping[field]);
        if (missingField) {
            return res.status(400).json({ message: `Please provide your ${missingField}.` });
        }

        const method = shippingMethod === 'express' ? 'express' : 'standard';
        const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
        const shippingCost = SHIPPING_COST[method];
        const total = subtotal + shippingCost;

        const order = await Order.create({
            user: req.userId || undefined,
            items,
            shipping,
            shippingMethod: method,
            subtotal,
            shippingCost,
            total,
        });

        res.status(201).json({ order });
    } catch (err) {
        console.error('Create order error:', err);
        res.status(500).json({ message: 'Something went wrong while placing your order.' });
    }
});

// GET /api/orders/mine  (requires login) - order history for the signed-in user
router.get('/mine', requireAuth, async (req, res) => {
    try {
        const orders = await Order.find({ user: req.userId }).sort({ createdAt: -1 });
        res.json({ orders });
    } catch (err) {
        res.status(500).json({ message: 'Could not load your orders.' });
    }
});

/* ============================================================
   Admin-only routes below (require a valid admin JWT token)
   ============================================================ */

// GET /api/orders/admin/all?status=pending  - every order, for the admin dashboard
router.get('/admin/all', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { status } = req.query;
        const filter = {};
        if (status) filter.status = status;

        const orders = await Order.find(filter).sort({ createdAt: -1 });
        res.json({ orders });
    } catch (err) {
        console.error('Admin get orders error:', err);
        res.status(500).json({ message: 'Could not load orders.' });
    }
});

// PATCH /api/orders/admin/:id/status  - update an order's status
router.patch('/admin/:id/status', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { status } = req.body;
        const validStatuses = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];

        if (!validStatuses.includes(status)) {
            return res.status(400).json({ message: 'Invalid status value.' });
        }

        const order = await Order.findByIdAndUpdate(req.params.id, { status }, { new: true });
        if (!order) return res.status(404).json({ message: 'Order not found.' });

        res.json({ order });
    } catch (err) {
        console.error('Update order status error:', err);
        res.status(500).json({ message: 'Could not update order status.' });
    }
});

// GET /api/orders/:id  - order confirmation lookup (used right after checkout)
// NOTE: kept last so it doesn't swallow the /mine and /admin/* routes above.
router.get('/:id', async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found.' });
        res.json({ order });
    } catch (err) {
        res.status(404).json({ message: 'Order not found.' });
    }
});

module.exports = router;