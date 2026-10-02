const crypto = require('crypto');
const mongoose = require('mongoose');
const { verifyTrackingToken } = require('./orderTracking');

/**
 * Guest-order access.
 *
 * Order ids are Mongo ObjectIds - guessable enough that they must never be the
 * only thing protecting a customer's name / address / phone. At checkout the
 * server creates a random secret "access token", stores only its SHA-256 hash
 * on the order and returns the raw token ONCE to the browser that placed the
 * order. Later requests prove ownership by sending it in `X-Order-Token`.
 * Signed-in owners and admins don't need the token.
 */
const ORDER_TOKEN_HEADER = 'x-order-token';

function generateOrderAccessToken() {
    const token = crypto.randomBytes(32).toString('hex');
    return { token, hash: hashOrderAccessToken(token) };
}

function hashOrderAccessToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function safeEqualHex(a, b) {
    const ba = Buffer.from(String(a || ''), 'utf8');
    const bb = Buffer.from(String(b || ''), 'utf8');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function isValidObjectId(id) {
    return typeof id === 'string' && mongoose.Types.ObjectId.isValid(id) && /^[a-f0-9]{24}$/i.test(id);
}

/**
 * Decides whether a caller may read/act on an order.
 * @param order  order document (must include accessTokenHash if a token could be used)
 * @param caller { userId, isAdmin, token }
 */
function canAccessOrder(order, { userId, isAdmin, token } = {}) {
    if (!order) return false;
    if (isAdmin) return true;
    if (userId && order.user && String(order.user) === String(userId)) return true;
    if (token && order.accessTokenHash && safeEqualHex(hashOrderAccessToken(token), order.accessTokenHash)) return true;
    return false;
}

/**
 * READ-ONLY access (view the order, follow its live status): everything canAccessOrder allows,
 * plus a valid signed email-tracking token for this exact order. Payment and cancel endpoints
 * keep using canAccessOrder, so an emailed link can never spend or change anything.
 */
function canViewOrder(order, caller = {}) {
    if (!order) return false;
    if (canAccessOrder(order, caller)) return true;
    return Boolean(caller.trackingToken) && verifyTrackingToken(caller.trackingToken, order._id);
}

function tokenFromRequest(req) {
    const value = req.headers[ORDER_TOKEN_HEADER];
    return typeof value === 'string' && value.length <= 128 ? value : undefined;
}

module.exports = {
    ORDER_TOKEN_HEADER,
    generateOrderAccessToken,
    hashOrderAccessToken,
    canAccessOrder,
    canViewOrder,
    tokenFromRequest,
    isValidObjectId,
    safeEqualHex,
};
