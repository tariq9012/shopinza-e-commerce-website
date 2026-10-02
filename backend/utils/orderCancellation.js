const Product = require('../models/Product');
const Order = require('../models/Order');
const Coupon = require('../models/Coupon');

/** Statuses an ADMIN cancel may start from (utils/orderStatus.js further blocks online-paid orders). */
const CANCELLABLE_STATUSES = ['pending', 'paid'];
/** A customer may self-cancel only an order that has not been paid: no money moves, so no refund is owed. */
const CUSTOMER_CANCELLABLE_STATUSES = ['pending'];

/**
 * Cancels an order and puts its stock back - EXACTLY ONCE.
 *
 * The status flip is a single conditional update (`status` must still be
 * cancellable). Only the caller that wins that update restocks, so a double
 * click, a retry, the cleanup job racing an admin, or two admins cancelling at
 * the same time can never give the same stock back twice. Must run inside an
 * active transaction (session) so flip + restock + coupon rollback are all-or-nothing.
 *
 * @param order   order document (only _id/items/couponCode are read)
 * @param session mongoose session
 * @returns the updated order, or null if it was no longer cancellable
 */
async function restockAndCancelOrder(order, session, allowedFrom = CANCELLABLE_STATUSES) {
    const cancelled = await Order.findOneAndUpdate(
        { _id: order._id, status: { $in: allowedFrom } },
        { $set: { status: 'cancelled', cancelledAt: new Date() } },
        { new: true, session }
    );

    if (!cancelled) return null; // someone else already cancelled/shipped it - do NOT restock

    for (const item of cancelled.items) {
        if (item.color && item.size) {
            // restock the specific variant AND the aggregate `stock` field
            // together, mirroring how the decrement in orderRoutes.js works
            await Product.findOneAndUpdate(
                { slug: item.productId, variants: { $elemMatch: { color: item.color, size: item.size } } },
                { $inc: { 'variants.$[v].stock': item.qty, stock: item.qty } },
                { arrayFilters: [{ 'v.color': item.color, 'v.size': item.size }], session }
            );
        } else {
            await Product.findOneAndUpdate({ slug: item.productId }, { $inc: { stock: item.qty } }, { session });
        }
    }

    // give the coupon redemption back too (it was consumed when the order was placed)
    if (cancelled.couponCode) {
        await Coupon.updateOne({ code: cancelled.couponCode, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }, { session });
    }

    return cancelled;
}

module.exports = { restockAndCancelOrder, CANCELLABLE_STATUSES, CUSTOMER_CANCELLABLE_STATUSES };
