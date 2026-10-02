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

// GET /api/admin/analytics?days=30&lowStockThreshold=5
// Everything the dashboard's charts need, bundled into one call:
//   - revenueByDay: daily revenue for the last `days` days (missing days filled with 0, so the line chart has no gaps)
//   - topProducts: best-sellers by quantity sold
//   - salesByCategory: revenue split by product category
//   - lowStock: products at or below `lowStockThreshold` units left
router.get('/analytics', requireAuth, requireAdmin, async (req, res) => {
    try {
        const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
        const lowStockThreshold = Math.max(parseInt(req.query.lowStockThreshold, 10) || 5, 0);

        const since = new Date();
        since.setDate(since.getDate() - (days - 1));
        since.setHours(0, 0, 0, 0);

        // Only orders that actually resulted in a sale count toward revenue -
        // matches the same status filter /stats already uses.
        const paidStatuses = ['paid', 'shipped', 'delivered'];

        const [revenueRows, topProducts, salesByCategory, lowStock] = await Promise.all([
            Order.aggregate([
                { $match: { status: { $in: paidStatuses }, createdAt: { $gte: since } } },
                {
                    $group: {
                        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                        revenue: { $sum: '$total' },
                    },
                },
            ]),

            Order.aggregate([
                { $match: { status: { $in: paidStatuses } } },
                { $unwind: '$items' },
                {
                    $group: {
                        _id: '$items.productId',
                        name: { $first: '$items.name' },
                        image: { $first: '$items.image' },
                        qty: { $sum: '$items.qty' },
                        revenue: { $sum: { $multiply: ['$items.price', '$items.qty'] } },
                    },
                },
                { $sort: { qty: -1 } },
                { $limit: 5 },
            ]),

            Order.aggregate([
                { $match: { status: { $in: paidStatuses } } },
                { $unwind: '$items' },
                {
                    // items only store the product's slug, so look up its
                    // current category from the Product collection
                    $lookup: {
                        from: 'products',
                        localField: 'items.productId',
                        foreignField: 'slug',
                        as: 'product',
                    },
                },
                { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
                {
                    $group: {
                        _id: { $ifNull: ['$product.category', 'Uncategorized'] },
                        revenue: { $sum: { $multiply: ['$items.price', '$items.qty'] } },
                    },
                },
                { $sort: { revenue: -1 } },
            ]),

            Product.find({ stock: { $lte: lowStockThreshold } })
                .sort({ stock: 1 })
                .limit(20)
                .select('name slug image stock category'),
        ]);

        // Fill in every day in the range (even ones with zero revenue) so the
        // line chart doesn't have misleading gaps.
        const revenueByDay = [];
        const revenueByDate = new Map(revenueRows.map((row) => [row._id, row.revenue]));
        for (let i = 0; i < days; i += 1) {
            const date = new Date(since);
            date.setDate(date.getDate() + i);
            const key = date.toISOString().slice(0, 10);
            revenueByDay.push({ date: key, revenue: revenueByDate.get(key) || 0 });
        }

        res.json({
            revenueByDay,
            topProducts: topProducts.map((p) => ({ name: p.name, image: p.image, qty: p.qty, revenue: p.revenue })),
            salesByCategory: salesByCategory.map((c) => ({ category: c._id, revenue: c.revenue })),
            lowStock,
            lowStockThreshold,
        });
    } catch (err) {
        console.error('Admin analytics error:', err);
        res.status(500).json({ message: 'Could not load analytics.' });
    }
});

module.exports = router;