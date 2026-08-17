const express = require('express');
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const ContactMessage = require('../models/ContactMessage');
const Subscriber = require('../models/Subscriber');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/admin/stats  - summary numbers for the dashboard overview
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
    try {
        const [
            totalOrders,
            pendingOrders,
            totalProducts,
            totalUsers,
            unresolvedMessages,
            totalSubscribers,
            revenueAgg,
        ] = await Promise.all([
            Order.countDocuments(),
            Order.countDocuments({ status: 'pending' }),
            Product.countDocuments(),
            User.countDocuments(),
            ContactMessage.countDocuments({ resolved: false }),
            Subscriber.countDocuments(),
            Order.aggregate([
                { $match: { status: { $in: ['paid', 'shipped', 'delivered'] } } },
                { $group: { _id: null, total: { $sum: '$total' } } },
            ]),
        ]);

        const recentOrders = await Order.find().sort({ createdAt: -1 }).limit(5);

        res.json({
            totalOrders,
            pendingOrders,
            totalProducts,
            totalUsers,
            unresolvedMessages,
            totalSubscribers,
            totalRevenue: revenueAgg[0]?.total || 0,
            recentOrders,
        });
    } catch (err) {
        console.error('Admin stats error:', err);
        res.status(500).json({ message: 'Could not load dashboard stats.' });
    }
});

module.exports = router;