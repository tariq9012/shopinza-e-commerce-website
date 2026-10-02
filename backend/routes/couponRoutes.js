const express = require('express');
const Coupon = require('../models/Coupon');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { findValidCoupon, computeDiscount } = require('../utils/couponValidation');

const router = express.Router();

// POST /api/coupons/validate  - body: { code, subtotal }
// Public (works for guest checkout too) - just checks whether a code is
// usable right now and what it would take off; doesn't reserve/use it.
// The actual usage count only increments when an order is placed (see
// orderRoutes.js), which re-validates everything again server-side anyway.
router.post('/validate', async (req, res) => {
    try {
        const { code, subtotal } = req.body;

        if (typeof subtotal !== 'number' || subtotal < 0) {
            return res.status(400).json({ message: 'Invalid order subtotal.' });
        }

        const coupon = await findValidCoupon(code, subtotal);
        const discount = computeDiscount(coupon, subtotal);

        res.json({
            code: coupon.code,
            type: coupon.type,
            value: coupon.value,
            discount,
        });
    } catch (err) {
        if (err.isCouponError) {
            return res.status(400).json({ message: err.message });
        }
        console.error('Validate coupon error:', err);
        res.status(500).json({ message: 'Could not validate this coupon right now.' });
    }
});

/* ============================================================
   Admin-only routes below (require a valid admin JWT token)
   ============================================================ */

// GET /api/coupons/admin/all
router.get('/admin/all', requireAuth, requireAdmin, async (req, res) => {
    try {
        const coupons = await Coupon.find().sort({ createdAt: -1 });
        res.json({ coupons });
    } catch (err) {
        res.status(500).json({ message: 'Could not load coupons.' });
    }
});

// POST /api/coupons/admin  - create a new coupon
router.post('/admin', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { code, type, value, maxDiscount, minOrderValue, usageLimit, expiresAt, active } = req.body;

        if (!code || !type || value == null) {
            return res.status(400).json({ message: 'Code, type, and value are required.' });
        }
        if (!['percent', 'fixed'].includes(type)) {
            return res.status(400).json({ message: 'Type must be "percent" or "fixed".' });
        }
        if (type === 'percent' && (value <= 0 || value > 100)) {
            return res.status(400).json({ message: 'A percent coupon must be between 1 and 100.' });
        }

        const coupon = await Coupon.create({
            code: String(code).trim().toUpperCase(),
            type,
            value,
            maxDiscount: maxDiscount || undefined,
            minOrderValue: minOrderValue || 0,
            usageLimit: usageLimit || undefined,
            expiresAt: expiresAt || undefined,
            active: active !== false,
        });

        res.status(201).json({ coupon });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(409).json({ message: 'A coupon with this code already exists.' });
        }
        console.error('Create coupon error:', err);
        res.status(500).json({ message: 'Could not create this coupon.' });
    }
});

// PATCH /api/coupons/admin/:id  - edit a coupon (e.g. toggle active, change value)
router.patch('/admin/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { type, value, maxDiscount, minOrderValue, usageLimit, expiresAt, active } = req.body;
        const update = {};

        if (type !== undefined) update.type = type;
        if (value !== undefined) update.value = value;
        if (maxDiscount !== undefined) update.maxDiscount = maxDiscount;
        if (minOrderValue !== undefined) update.minOrderValue = minOrderValue;
        if (usageLimit !== undefined) update.usageLimit = usageLimit;
        if (expiresAt !== undefined) update.expiresAt = expiresAt;
        if (active !== undefined) update.active = active;

        const coupon = await Coupon.findByIdAndUpdate(req.params.id, update, { new: true });
        if (!coupon) return res.status(404).json({ message: 'Coupon not found.' });

        res.json({ coupon });
    } catch (err) {
        console.error('Update coupon error:', err);
        res.status(500).json({ message: 'Could not update this coupon.' });
    }
});

// DELETE /api/coupons/admin/:id
router.delete('/admin/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const coupon = await Coupon.findByIdAndDelete(req.params.id);
        if (!coupon) return res.status(404).json({ message: 'Coupon not found.' });
        res.json({ message: 'Coupon deleted.' });
    } catch (err) {
        console.error('Delete coupon error:', err);
        res.status(500).json({ message: 'Could not delete this coupon.' });
    }
});

module.exports = router;
