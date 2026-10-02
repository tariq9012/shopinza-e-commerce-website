const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
    {
        code: { type: String, required: true, unique: true, uppercase: true, trim: true },
        type: { type: String, enum: ['percent', 'fixed'], required: true },
        // percent: 1-100 (e.g. 20 = 20% off). fixed: a flat dollar amount off.
        value: { type: Number, required: true, min: 0 },
        // caps how much a percent coupon can take off a single order (ignored for "fixed" coupons)
        maxDiscount: { type: Number },
        // order subtotal must be at least this much for the coupon to apply
        minOrderValue: { type: Number, default: 0 },
        // null/undefined = unlimited uses
        usageLimit: { type: Number },
        usedCount: { type: Number, default: 0 },
        // null/undefined = never expires
        expiresAt: { type: Date },
        active: { type: Boolean, default: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Coupon', couponSchema);
