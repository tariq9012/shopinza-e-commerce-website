/**
 * Allowed order status transitions. "cancelled" and "delivered" are terminal,
 * so a cancelled order can never be revived (which would sell stock that was
 * already given back) and can never be cancelled twice (double restock).
 *
 *   pending  -> paid | cancelled | shipped (cash-on-delivery only)
 *   paid     -> shipped | cancelled (cash-on-delivery only; online-paid orders are cancelled via Refund)
 *   shipped  -> delivered
 *   delivered, cancelled -> (nothing)
 */
const TRANSITIONS = {
    pending: ['paid', 'cancelled', 'shipped'],
    paid: ['shipped', 'cancelled'],
    shipped: ['delivered'],
    delivered: [],
    cancelled: [],
};

const ALL_STATUSES = Object.keys(TRANSITIONS);

function checkTransition(order, nextStatus) {
    const from = order.status;
    if (!ALL_STATUSES.includes(nextStatus)) return { ok: false, message: 'Invalid status value.' };
    if (from === nextStatus) return { ok: false, message: `This order is already ${from}.` };
    if (!TRANSITIONS[from] || !TRANSITIONS[from].includes(nextStatus)) {
        return { ok: false, message: `An order that is ${from} cannot be changed to ${nextStatus}.` };
    }
    // An ONLINE-paid order can't just be flipped to "cancelled": that would restock the goods and
    // tell the customer it's cancelled without their money ever being returned. It must go through
    // the admin Refund action (POST /api/orders/admin/:id/refund), which cancels only after the refund.
    if (from === 'paid' && nextStatus === 'cancelled' && order.paymentMethod !== 'cod') {
        return { ok: false, message: 'This order was paid online. Use the Refund action so the customer is actually refunded - the order is cancelled automatically once that succeeds.' };
    }
    // online-payment orders must be paid before they can ship
    if (from === 'pending' && nextStatus === 'shipped' && order.paymentMethod !== 'cod') {
        return { ok: false, message: 'This order has not been paid yet, so it cannot be shipped.' };
    }
    return { ok: true };
}

module.exports = { TRANSITIONS, ALL_STATUSES, checkTransition };
