const mongoose = require('mongoose');
const Order = require('../models/Order');
const { restockAndCancelOrder } = require('../utils/orderCancellation');

// how long a Stripe/JazzCash/Easypaisa order can sit unpaid before we treat it
// as abandoned and give the reserved stock back
const ABANDON_MINUTES = Number(process.env.ORDER_ABANDON_MINUTES) || 30;

// COD is intentionally excluded - a COD order is SUPPOSED to stay "pending"
// until it's delivered, that's not abandonment, it's just how COD works.
const ONLINE_PAYMENT_METHODS = ['stripe', 'jazzcash', 'easypaisa'];

/**
 * Finds orders that were started with an online payment method but never
 * completed payment, cancels them, and restocks their items so the product
 * doesn't stay falsely "out of stock" forever because of one abandoned checkout.
 */
async function cancelAbandonedOrders() {
    const cutoff = new Date(Date.now() - ABANDON_MINUTES * 60 * 1000);

    const candidates = await Order.find({
        status: 'pending',
        paymentMethod: { $in: ONLINE_PAYMENT_METHODS },
        createdAt: { $lt: cutoff },
        // switching payment method on an unpaid order (e.g. COD -> card) restarts the clock, so an
        // order that was just switched to an online method isn't cancelled a moment later
        $or: [{ paymentSwitchedAt: { $exists: false } }, { paymentSwitchedAt: null }, { paymentSwitchedAt: { $lt: cutoff } }],
    }).select('_id');

    if (candidates.length === 0) return { cancelled: 0 };

    let cancelledCount = 0;

    for (const candidate of candidates) {
        const session = await mongoose.startSession();
        try {
            let cancelledThisOne = false;

            await session.withTransaction(async () => {
                cancelledThisOne = false; // withTransaction may retry this callback
                // restockAndCancelOrder only flips orders that are STILL "pending" (atomic
                // conditional update), so if the customer's payment went through between
                // the query above and now, it returns null and nothing is restocked.
                const result = await restockAndCancelOrder(candidate, session, ['pending']);
                cancelledThisOne = Boolean(result);
            });

            if (cancelledThisOne) cancelledCount += 1;
        } catch (err) {
            console.error(`Abandoned-order cleanup failed for order ${candidate._id}:`, err.message);
        } finally {
            session.endSession();
        }
    }

    if (cancelledCount > 0) {
        console.log(`🧹 Cancelled ${cancelledCount} abandoned order(s) and restocked their items.`);
    }

    return { cancelled: cancelledCount };
}

module.exports = { cancelAbandonedOrders };
