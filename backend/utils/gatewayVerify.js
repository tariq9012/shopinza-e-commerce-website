const crypto = require('crypto');
const { generateSecureHash } = require('./secureHash');

function safeEqual(a, b) {
    const ba = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * The amount/currency the gateway was ASKED to charge, frozen on the order when the payment
 * was started (order.gatewayPayment, see config/currency.js). Callbacks are compared with it -
 * never with the USD order total, so a USD amount can't be mistaken for a PKR amount.
 */
function gatewaySnapshot(order, provider) {
    const g = order && order.gatewayPayment;
    if (!g || g.provider !== provider || !Number.isInteger(g.amountMinor) || !g.currency) return null;
    return g;
}

/**
 * JazzCash return callback. Returns { ok, reason }. ok === true only when
 *  - the pp_SecureHash is valid (computed from ONLY the pp_* fields, with our salt),
 *  - the bill reference is this order,
 *  - the transaction reference is the one we generated for this order,
 *  - the paid amount AND currency equal the snapshot taken when the payment was started,
 *  - and JazzCash reports success (pp_ResponseCode 000).
 */
function verifyJazzCashCallback(body, order, salt) {
    if (!salt) return { ok: false, reason: 'JazzCash is not configured' };
    if (!order) return { ok: false, reason: 'unknown order' };

    const params = {};
    for (const [key, value] of Object.entries(body || {})) {
        if (key.startsWith('pp_') && typeof value === 'string') params[key] = value;
    }
    const received = params.pp_SecureHash;
    delete params.pp_SecureHash;

    if (!received) return { ok: false, reason: 'missing hash' };
    if (!safeEqual(received.toLowerCase(), generateSecureHash(params, salt).toLowerCase())) {
        return { ok: false, reason: 'hash mismatch' };
    }
    if (params.pp_BillReference !== String(order._id)) return { ok: false, reason: 'order mismatch' };

    // The signature is genuine, but is this the CURRENT payment attempt? After the customer switched
    // to another payment method (or restarted JazzCash) the old attempt is stale: it must never pay
    // the order. It is reported as `stale` (+ whether the gateway says money was taken) so the route
    // can flag it for manual reconciliation without changing the order's status.
    if (order.paymentMethod !== 'jazzcash' || !order.paymentIntentId || params.pp_TxnRefNo !== order.paymentIntentId) {
        return {
            ok: false,
            stale: true,
            succeeded: params.pp_ResponseCode === '000',
            reason: 'stale payment attempt: the payment method changed or this transaction reference is not the current one',
        };
    }
    const snapshot = gatewaySnapshot(order, 'jazzcash');
    if (!snapshot) return { ok: false, reason: 'no quoted gateway amount for this order' };
    if (params.pp_TxnCurrency !== undefined && params.pp_TxnCurrency !== snapshot.currency) {
        return { ok: false, reason: 'currency mismatch' };
    }
    if (params.pp_Amount !== String(snapshot.amountMinor)) return { ok: false, reason: 'amount mismatch' };
    if (params.pp_ResponseCode !== '000') return { ok: false, reason: 'payment not successful', declined: true };

    return { ok: true, transactionId: params.pp_TxnRefNo };
}

/**
 * Easypaisa return callback - FAILS CLOSED.
 *
 * Easypaisa's hosted-checkout callback format could not be verified against
 * the real merchant documentation, so this never trusts the browser redirect
 * on its own. A callback is accepted only if it carries a hash that matches
 * HMAC-SHA256(EASYPAISA_HASH_KEY) over the other fields (same scheme as the
 * request signature), AND the order reference, amount and success status all
 * match. Anything else leaves the order "pending" for manual reconciliation.
 * Once you have Easypaisa's real callback/inquiry spec, adapt this ONE function.
 */
const EASYPAISA_HASH_FIELDS = ['merchantHashedResp', 'merchantHashedReq', 'hash'];

function verifyEasypaisaCallback(body, order, hashKey) {
    if (!hashKey) return { ok: false, reason: 'Easypaisa is not configured' };
    if (!order) return { ok: false, reason: 'unknown order' };

    const params = {};
    let received;
    for (const [key, value] of Object.entries(body || {})) {
        if (typeof value !== 'string') continue;
        if (EASYPAISA_HASH_FIELDS.includes(key)) received = received || value;
        else params[key] = value;
    }

    if (!received) return { ok: false, reason: 'callback is not signed' };
    if (!safeEqual(received.toLowerCase(), generateSecureHash(params, hashKey).toLowerCase())) {
        return { ok: false, reason: 'hash mismatch' };
    }
    if (params.orderRefNum !== String(order._id)) return { ok: false, reason: 'order mismatch' };

    // Easypaisa's order reference IS the order id, so attempts can only be told apart by the payment
    // method and the quoted snapshot: after a switch the old callback is stale and must not pay.
    const status0 = params.status || params.responseCode;
    if (order.paymentMethod !== 'easypaisa' || order.paymentIntentId !== String(order._id)) {
        return {
            ok: false,
            stale: true,
            succeeded: status0 === 'SUCCESS' || status0 === '0000',
            reason: 'stale payment attempt: the payment method changed',
        };
    }
    const snapshot = gatewaySnapshot(order, 'easypaisa');
    if (!snapshot) return { ok: false, reason: 'no quoted gateway amount for this order' };
    if (params.amount === undefined) return { ok: false, reason: 'amount missing' };
    if (Math.round(Number(params.amount) * 100) !== snapshot.amountMinor) return { ok: false, reason: 'amount mismatch' };

    const status = params.status || params.responseCode;
    if (status !== 'SUCCESS' && status !== '0000') return { ok: false, reason: 'payment not successful', declined: true };

    return { ok: true, transactionId: params.transactionId || String(order._id) };
}

module.exports = { verifyJazzCashCallback, verifyEasypaisaCallback, safeEqual };
