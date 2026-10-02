const Coupon = require('../models/Coupon');

/**
 * Looks up a coupon by code and checks it's actually usable for this order
 * (active, not expired, under its usage limit, order meets the minimum).
 * Does NOT increment usedCount - callers that are about to commit an order
 * should do that atomically themselves (see orderRoutes.js) to avoid a race
 * where two checkouts both "use" the last remaining redemption.
 *
 * Throws an Error with `.isCouponError = true` and a customer-friendly
 * message on any validation failure.
 */
async function findValidCoupon(rawCode, subtotal, session) {
    const code = String(rawCode || '').trim().toUpperCase();

    if (!code) {
        const err = new Error('Please enter a coupon code.');
        err.isCouponError = true;
        throw err;
    }

    const query = Coupon.findOne({ code });
    const coupon = session ? await query.session(session) : await query;

    if (!coupon) {
        const err = new Error('This coupon code is not valid.');
        err.isCouponError = true;
        throw err;
    }

    if (!coupon.active) {
        const err = new Error('This coupon is no longer active.');
        err.isCouponError = true;
        throw err;
    }

    if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) {
        const err = new Error('This coupon has expired.');
        err.isCouponError = true;
        throw err;
    }

    if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
        const err = new Error('This coupon has reached its usage limit.');
        err.isCouponError = true;
        throw err;
    }

    if (subtotal < coupon.minOrderValue) {
        const err = new Error(`This coupon requires a minimum order of $${coupon.minOrderValue.toFixed(2)}.`);
        err.isCouponError = true;
        throw err;
    }

    return coupon;
}

/** Computes the discount amount a coupon gives on a given subtotal. Never exceeds the subtotal itself. */
function computeDiscount(coupon, subtotal) {
    let discount;

    if (coupon.type === 'percent') {
        discount = subtotal * (coupon.value / 100);
        if (coupon.maxDiscount != null) discount = Math.min(discount, coupon.maxDiscount);
    } else {
        discount = coupon.value;
    }

    discount = Math.min(discount, subtotal);
    return Math.round(discount * 100) / 100; // round to cents
}

module.exports = { findValidCoupon, computeDiscount };
