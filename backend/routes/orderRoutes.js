const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Product = require('../models/Product');
const Coupon = require('../models/Coupon');
const User = require('../models/User');
const { optionalAuth, requireAuth, requireAdmin } = require('../middleware/auth');
const { restockAndCancelOrder, CUSTOMER_CANCELLABLE_STATUSES } = require('../utils/orderCancellation');
const stripe = require('../config/stripe');
const { STORE_CURRENCY } = require('../config/currency');
const { sendOrderPlacedEmail, sendOrderStatusEmail } = require('../utils/orderMailer');
const { findValidCoupon, computeDiscount } = require('../utils/couponValidation');
const { emitOrderUpdate } = require('../socket');
const { toCents } = require('../utils/money');
const { OrderInputError, normalizeRequestedItems, priceItems, computeTotals } = require('../utils/orderPricing');
const { generateOrderAccessToken, canViewOrder, tokenFromRequest, isValidObjectId } = require('../utils/orderAccess');
const { trackingTokenFromRequest } = require('../utils/orderTracking');
const { checkTransition } = require('../utils/orderStatus');
const { cleanShipping, isString } = require('../utils/validate');

const router = express.Router();

const SHIPPING_COST = { standard: 0, express: 25 };

/** Order as sent to a client - never includes the access-token hash. */
function publicOrder(order) {
    const obj = typeof order.toObject === 'function' ? order.toObject() : { ...order };
    delete obj.accessTokenHash;
    return obj;
}

// POST /api/orders  (checkout) - works for guests too, but attaches the user if logged in
//
// SECURITY: the client only says WHICH products, how many, and which colour/size.
// Names, prices and images are read from MongoDB here, totals/discounts/shipping
// are computed here, and quantities must be whole numbers >= 1. Nothing about
// money is ever taken from the request body.
//
// Stock is validated and decremented atomically inside a transaction so two
// customers can never both "win" the last item in stock (overselling).
router.post('/', optionalAuth, async (req, res) => {
    const { items: rawItems, shipping: rawShipping, shippingMethod, paymentMethod, couponCode } = req.body || {};

    let requested;
    try {
        requested = normalizeRequestedItems(rawItems);
    } catch (err) {
        return res.status(err.status || 400).json({ message: err.message });
    }

    const { shipping, error: shippingError } = cleanShipping(rawShipping);
    if (shippingError) return res.status(400).json({ message: shippingError });

    if (couponCode !== undefined && couponCode !== null && couponCode !== '' && !isString(couponCode, { max: 40 })) {
        return res.status(400).json({ message: 'This coupon code is not valid.' });
    }

    const validPaymentMethods = ['cod', 'stripe', 'jazzcash', 'easypaisa'];
    const resolvedPaymentMethod = validPaymentMethods.includes(paymentMethod) ? paymentMethod : 'cod';
    const method = shippingMethod === 'express' ? 'express' : 'standard';

    const session = await mongoose.startSession();

    try {
        // ---- read the REAL product data and price the cart from it ----
        const slugs = [...new Set(requested.map((line) => line.productId))];
        const products = await Product.find({ slug: { $in: slugs } }).lean();
        const productsBySlug = new Map(products.map((p) => [p.slug, p]));
        const { items, subtotalCents } = priceItems(requested, productsBySlug);

        const access = generateOrderAccessToken();
        let order;

        await session.withTransaction(async () => {
            // 1) Atomically decrement stock for every item, one at a time.
            //    The filter (stock: { $gte: qty }) makes this check-and-decrement
            //    a single atomic DB operation, so a race between two simultaneous
            //    checkouts can never push stock below zero.
            for (const item of items) {
                const hasVariant = Boolean(item.color && item.size);

                const updatedProduct = hasVariant
                    ? await Product.findOneAndUpdate(
                          {
                              slug: item.productId,
                              variants: { $elemMatch: { color: item.color, size: item.size, stock: { $gte: item.qty } } },
                          },
                          {
                              // decrement the specific variant AND the aggregate
                              // `stock` field together, atomically, so `stock`
                              // stays accurate as "sum of all variants" everywhere
                              // else in the app that still just reads it directly.
                              $inc: { 'variants.$[v].stock': -item.qty, stock: -item.qty },
                          },
                          { arrayFilters: [{ 'v.color': item.color, 'v.size': item.size }], new: true, session }
                      )
                    : await Product.findOneAndUpdate(
                          { slug: item.productId, stock: { $gte: item.qty } },
                          { $inc: { stock: -item.qty } },
                          { new: true, session }
                      );

                if (!updatedProduct) {
                    // either the product/variant doesn't exist, or there isn't enough stock left
                    const existingProduct = await Product.findOne({ slug: item.productId }).session(session);
                    const variantLabel = hasVariant ? ` (${item.color} / ${item.size})` : '';

                    let failMessage = `"${item.name}"${variantLabel} is no longer available.`;
                    if (existingProduct) {
                        if (hasVariant) {
                            const variant = existingProduct.variants.find(
                                (v) => v.color === item.color && v.size === item.size
                            );
                            failMessage = variant
                                ? `Sorry, only ${variant.stock} of "${existingProduct.name}"${variantLabel} left in stock.`
                                : `"${existingProduct.name}"${variantLabel} is not available.`;
                        } else {
                            failMessage = `Sorry, only ${existingProduct.stock} of "${existingProduct.name}" left in stock.`;
                        }
                    }

                    const stockError = new Error(failMessage);
                    stockError.isStockError = true;
                    throw stockError;
                }
            }

            // 2) Re-validate and apply the coupon (if any) here, server-side, against
            //    the subtotal WE computed - never a client-supplied amount.
            let discountCents = 0;
            let appliedCouponCode;

            if (couponCode) {
                const coupon = await findValidCoupon(couponCode, subtotalCents / 100, session);
                discountCents = toCents(computeDiscount(coupon, subtotalCents / 100));

                // Atomic, usage-limit-safe increment - mirrors the stock
                // decrement above, so two simultaneous checkouts can never
                // both "win" the last redemption of a limited coupon.
                const updatedCoupon = await Coupon.findOneAndUpdate(
                    {
                        _id: coupon._id,
                        $or: [{ usageLimit: null }, { usageLimit: { $exists: false } }, { $expr: { $lt: ['$usedCount', '$usageLimit'] } }],
                    },
                    { $inc: { usedCount: 1 } },
                    { session }
                );

                if (!updatedCoupon) {
                    const err = new Error('This coupon just reached its usage limit. Please remove it and try again.');
                    err.isCouponError = true;
                    throw err;
                }

                appliedCouponCode = coupon.code;
            }

            const totals = computeTotals({
                subtotalCents,
                shippingCents: toCents(SHIPPING_COST[method]),
                discountCents,
            });

            // 3) Only create the order once every item's stock (and the coupon, if any) was successfully reserved.
            const createdOrders = await Order.create(
                [
                    {
                        user: req.userId || undefined,
                        items,
                        shipping,
                        shippingMethod: method,
                        paymentMethod: resolvedPaymentMethod,
                        currency: STORE_CURRENCY,
                        subtotal: totals.subtotal,
                        shippingCost: totals.shippingCost,
                        couponCode: appliedCouponCode,
                        discount: totals.discount,
                        total: totals.total,
                        accessTokenHash: access.hash,
                    },
                ],
                { session }
            );

            order = createdOrders[0];
        });

        // the raw access token is returned ONCE, here - the browser keeps it to
        // view/pay for this (possibly guest) order later
        res.status(201).json({ order: publicOrder(order), accessToken: access.token });

        // Cash-on-delivery has no online payment step, so the order is
        // effectively confirmed right away. Online-payment orders (Stripe/
        // JazzCash/Easypaisa) get their confirmation email once the gateway
        // actually confirms the charge instead (see paymentRoutes.js).
        if (order.paymentMethod === 'cod') {
            sendOrderPlacedEmail(order).catch((err) => console.error('Order placed email error:', err));
        }
    } catch (err) {
        if (err instanceof OrderInputError) {
            return res.status(err.status).json({ message: err.message });
        }
        if (err.isStockError) {
            return res.status(409).json({ message: err.message });
        }
        if (err.isCouponError) {
            return res.status(400).json({ message: err.message });
        }
        console.error('Create order error:', err);
        res.status(500).json({ message: 'Something went wrong while placing your order.' });
    } finally {
        session.endSession();
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

// PATCH /api/orders/:id/cancel  (requires login) - customer self-service cancel
// Only the order's own owner can cancel it, and ONLY while it is still unpaid ("pending"):
// nothing was charged, so nothing needs refunding. A paid order must go through support +
// the admin Refund action - it is never just flipped to "cancelled" (that would restock the
// goods and promise a refund that never happened).
router.patch('/:id/cancel', requireAuth, async (req, res) => {
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Order not found.' });

    const session = await mongoose.startSession();

    try {
        let order;
        let failure;

        await session.withTransaction(async () => {
            failure = undefined;
            const existingOrder = await Order.findById(req.params.id).session(session);

            if (!existingOrder) {
                failure = { status: 404, message: 'Order not found.' };
                return;
            }
            if (!existingOrder.user || String(existingOrder.user) !== String(req.userId)) {
                failure = { status: 403, message: 'You can only cancel your own orders.' };
                return;
            }
            if (!CUSTOMER_CANCELLABLE_STATUSES.includes(existingOrder.status)) {
                let message = 'This order can no longer be cancelled here. Please contact support.';
                if (existingOrder.status === 'cancelled') message = 'This order has already been cancelled.';
                else if (existingOrder.status === 'paid') {
                    message = 'This order has already been paid. To cancel it and arrange a refund, please contact support - it cannot be cancelled here.';
                } else if (existingOrder.status === 'shipped' || existingOrder.status === 'delivered') {
                    message = 'This order has already shipped and can no longer be cancelled. Please contact support instead.';
                }
                failure = { status: 400, message };
                return;
            }

            // atomic: only the request that actually flips the status restocks
            order = await restockAndCancelOrder(existingOrder, session, CUSTOMER_CANCELLABLE_STATUSES);
            if (!order) failure = { status: 409, message: 'This order was just updated. Please refresh and try again.' };
        });

        if (failure) return res.status(failure.status).json({ message: failure.message });

        res.json({ order: publicOrder(order) });

        sendOrderStatusEmail(order).catch((err) => console.error('Order status email error:', err));
        emitOrderUpdate(order); // live-push the new status to anyone watching this order right now
    } catch (err) {
        console.error('Cancel order error:', err);
        res.status(500).json({ message: 'Could not cancel your order.' });
    } finally {
        session.endSession();
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
        if (typeof status === 'string' && status) filter.status = status; // string only - blocks {"$ne": ...} operator injection

        const orders = await Order.find(filter).sort({ createdAt: -1 });
        res.json({ orders });
    } catch (err) {
        console.error('Admin get orders error:', err);
        res.status(500).json({ message: 'Could not load orders.' });
    }
});

// PATCH /api/orders/admin/:id/status  - update an order's status
// Only valid transitions are allowed (see utils/orderStatus.js): cancelled and
// delivered orders are final, so stock can never be restored twice or "revived".
// Cancelling puts the items' stock back (they were reserved at checkout).
router.patch('/admin/:id/status', requireAuth, requireAdmin, async (req, res) => {
    const { status } = req.body || {};
    if (typeof status !== 'string') return res.status(400).json({ message: 'Invalid status value.' });
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Order not found.' });

    const session = await mongoose.startSession();

    try {
        let order;
        let failure;

        await session.withTransaction(async () => {
            failure = undefined;
            const existingOrder = await Order.findById(req.params.id).session(session);

            if (!existingOrder) {
                failure = { status: 404, message: 'Order not found.' };
                return;
            }

            const check = checkTransition(existingOrder, status);
            if (!check.ok) {
                failure = { status: 409, message: check.message };
                return;
            }

            if (status === 'cancelled') {
                order = await restockAndCancelOrder(existingOrder, session);
            } else {
                const set = { status };
                if (status === 'paid') {
                    set.paidAt = new Date();
                    set.transactionId = existingOrder.transactionId || 'manual-admin';
                }
                // the filter pins the status we validated, so two admins racing can't both apply
                order = await Order.findOneAndUpdate(
                    { _id: existingOrder._id, status: existingOrder.status },
                    { $set: set },
                    { new: true, session }
                );
            }

            if (!order) failure = { status: 409, message: 'This order was just updated by someone else. Please refresh.' };
        });

        if (failure) return res.status(failure.status).json({ message: failure.message });

        res.json({ order: publicOrder(order) });

        // Only these statuses have a customer-facing email template (see
        // orderMailer.js) - "pending"/"paid" are handled elsewhere (order
        // placed / payment confirmed emails), so this is a no-op for those.
        sendOrderStatusEmail(order).catch((err) => console.error('Order status email error:', err));
        emitOrderUpdate(order); // live-push the new status to anyone watching this order right now
    } catch (err) {
        console.error('Update order status error:', err);
        res.status(500).json({ message: 'Could not update order status.' });
    } finally {
        session.endSession();
    }
});

// POST /api/orders/admin/:id/refund  - body: { manualReference?, note? }
// The ONLY way an online-paid order is cancelled. The order is cancelled (and its stock and
// coupon restored, exactly once) only AFTER the money side succeeded:
//   - Stripe: a real refund is created with an idempotency key (a retry can never refund twice).
//   - JazzCash / Easypaisa: automated refunds are not implemented. Without `manualReference`
//     the order is just flagged "manual_required" and left untouched; once an admin has refunded
//     the customer in the provider's portal they call this again with the refund's reference.
//   - A payment that arrived AFTER the order was cancelled (status cancelled + paymentIssue)
//     is refunded the same way, without restocking again.
const REFUND_CLAIMABLE = [null, 'none', 'failed', 'pending', 'manual_required'];

function stripePaymentIntentIdFor(order) {
    if (typeof order.transactionId === 'string' && order.transactionId.startsWith('pi_')) return order.transactionId;
    if (typeof order.paymentIntentId === 'string' && order.paymentIntentId.startsWith('pi_')) return order.paymentIntentId;
    return null;
}

router.post('/admin/:id/refund', requireAuth, requireAdmin, async (req, res) => {
    const { manualReference, note } = req.body || {};
    if (manualReference !== undefined && !isString(manualReference, { min: 3, max: 100 })) {
        return res.status(400).json({ message: 'The refund reference must be 3-100 characters.' });
    }
    if (note !== undefined && !isString(note, { max: 300 })) {
        return res.status(400).json({ message: 'The note is too long (max 300 characters).' });
    }
    if (!isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Order not found.' });

    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found.' });

        const lateCancelled = order.status === 'cancelled' && Boolean(order.paymentIssue);
        if (order.status !== 'paid' && !lateCancelled) {
            return res.status(409).json({ message: 'Only paid orders (or cancelled orders that received a late payment) can be refunded.' });
        }
        if (['succeeded', 'manual_done'].includes(order.refundStatus)) {
            return res.status(409).json({ message: 'This order has already been refunded.' });
        }
        if (order.paymentMethod === 'cod') {
            return res.status(409).json({ message: 'Cash-on-delivery orders have no online payment to refund. Cancel it from the status menu instead.' });
        }

        const isStripe = order.paymentMethod === 'stripe';
        const reference = isStripe ? undefined : manualReference;

        // --- JazzCash / Easypaisa without a reference: flag it, change nothing else, promise nothing ---
        if (!isStripe && !reference) {
            await Order.updateOne(
                { _id: order._id, refundStatus: { $in: REFUND_CLAIMABLE } },
                { $set: { refundStatus: 'manual_required', refundNote: 'Refund this customer in the provider portal, then record the reference here.' } }
            );
            return res.status(409).json({
                manualRequired: true,
                message: `Automated refunds are not available for ${order.paymentMethod}. Refund the customer in the provider's merchant portal, then run this action again with the refund's reference number. The order has NOT been cancelled.`,
            });
        }

        // --- claim the refund (concurrent admins / retries are safe: see idempotency key below) ---
        const claimed = await Order.findOneAndUpdate(
            { _id: order._id, status: order.status, refundStatus: { $in: REFUND_CLAIMABLE } },
            { $set: note ? { refundStatus: 'pending', refundNote: note } : { refundStatus: 'pending' } },
            { new: true }
        );
        if (!claimed) return res.status(409).json({ message: 'This order was just updated or is already refunded. Please refresh.' });

        let refundId = reference;
        let refundStatus = 'manual_done';

        if (isStripe) {
            const paymentIntentId = stripePaymentIntentIdFor(order);
            if (!paymentIntentId) {
                await Order.updateOne({ _id: order._id, refundStatus: 'pending' }, { $set: { refundStatus: 'failed', refundNote: 'No Stripe payment reference on this order.' } });
                return res.status(409).json({ message: 'This order has no Stripe payment reference, so it cannot be refunded automatically.' });
            }

            let refund;
            try {
                refund = await stripe.refunds.create(
                    { payment_intent: paymentIntentId, reason: 'requested_by_customer', metadata: { orderId: String(order._id) } },
                    { idempotencyKey: `shopinza-refund-${order._id}` }
                );
            } catch (err) {
                console.error('Stripe refund error:', err.message);
                await Order.updateOne({ _id: order._id, refundStatus: 'pending' }, { $set: { refundStatus: 'failed', refundNote: 'Stripe rejected or could not process the refund.' } });
                return res.status(502).json({ message: 'Stripe could not process the refund. The order was NOT cancelled and no stock was restored. Please try again.' });
            }

            if (refund.status === 'failed' || refund.status === 'canceled') {
                await Order.updateOne({ _id: order._id, refundStatus: 'pending' }, { $set: { refundStatus: 'failed', refundNote: `Stripe refund ${refund.status}.` } });
                return res.status(502).json({ message: `Stripe reported the refund as ${refund.status}. The order was NOT cancelled.` });
            }

            refundId = refund.id;
            refundStatus = refund.status === 'succeeded' ? 'succeeded' : 'pending'; // "pending" = initiated, still settling
        }

        // --- the money side succeeded: now cancel + restock, exactly once ---
        const session = await mongoose.startSession();
        try {
            let cancelledNow = null;

            await session.withTransaction(async () => {
                cancelledNow = null;
                if (order.status === 'paid') {
                    cancelledNow = await restockAndCancelOrder(order, session, ['paid']); // null if someone else already finalised it
                }
                await Order.updateOne(
                    { _id: order._id },
                    { $set: { refundStatus, refundId, refundedAt: new Date() } },
                    { session }
                );
            });

            const fresh = await Order.findById(order._id);
            res.json({ order: publicOrder(fresh), refund: { status: refundStatus, provider: order.paymentMethod, refundId } });

            if (cancelledNow) {
                // the email states only what happened (see orderMailer.js cancelledCopy)
                sendOrderStatusEmail(fresh).catch((err) => console.error('Order status email error:', err));
                emitOrderUpdate(fresh);
            }
        } finally {
            session.endSession();
        }
    } catch (err) {
        console.error('Refund error:', err);
        res.status(500).json({ message: 'Could not process the refund.' });
    }
});

// GET /api/orders/:id  - order details (confirmation page / order view)
// PRIVATE: only the signed-in owner, an admin, the browser holding the order's checkout
// access token (X-Order-Token), or someone with a valid signed emailed tracking token
// (X-Order-Tracking-Token, read-only) may read it. Anyone else gets
// a plain 404 so order ids can't even be probed.
// NOTE: kept last so it doesn't swallow the /mine and /admin/* routes above.
router.get('/:id', optionalAuth, async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Order not found.' });

        const order = await Order.findById(req.params.id).select('+accessTokenHash');

        let isAdmin = false;
        if (order && req.userId) {
            const user = await User.findById(req.userId).select('role').lean();
            isAdmin = Boolean(user && user.role === 'admin');
        }

        if (!canViewOrder(order, { userId: req.userId, isAdmin, token: tokenFromRequest(req), trackingToken: trackingTokenFromRequest(req) })) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        res.json({ order: publicOrder(order) });
    } catch (err) {
        console.error('Get order error:', err);
        res.status(404).json({ message: 'Order not found.' });
    }
});

module.exports = router;
