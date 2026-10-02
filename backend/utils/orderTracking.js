const crypto = require('crypto');
const { isProduction } = require('./origins');

/**
 * Guest "Track your order" links in emails.
 *
 * A signed, expiring, READ-ONLY token bound to ONE order id. It is:
 *   token = <orderId>.<expiresAtSeconds>.<base64url(HMAC-SHA256(secret, "order-tracking|v1|<orderId>|<exp>"))>
 * - forged/edited tokens fail (they can't be signed without ORDER_TRACKING_SECRET),
 * - a token for order A never works for order B (the id is inside the signed message),
 * - nothing is stored in MongoDB and nothing is logged,
 * - it only lets someone VIEW the order (GET + live status). It cannot pay, cancel or change anything.
 * It rides in the URL fragment (#track=...), which browsers never send to servers or in Referer headers.
 */
const TTL_SECONDS = 180 * 24 * 60 * 60; // 180 days: emails stay in inboxes for a long time
const MAX_TOKEN_LENGTH = 200;
const TRACKING_HEADER = 'x-order-tracking-token';

function getSecret() {
    if (process.env.ORDER_TRACKING_SECRET) return process.env.ORDER_TRACKING_SECRET;
    // local development convenience only - production must set ORDER_TRACKING_SECRET explicitly
    if (!isProduction() && process.env.JWT_SECRET) return `dev-derived|${process.env.JWT_SECRET}`;
    return null;
}

function sign(secret, orderId, exp) {
    return crypto.createHmac('sha256', secret).update(`order-tracking|v1|${orderId}|${exp}`).digest('base64url');
}

/** @returns the token string, or null when no secret is configured (emails then simply omit the token) */
function createTrackingToken(orderId, nowMs = Date.now()) {
    const secret = getSecret();
    if (!secret) return null;
    const id = String(orderId);
    const exp = Math.floor(nowMs / 1000) + TTL_SECONDS;
    return `${id}.${exp}.${sign(secret, id, exp)}`;
}

/** true only for an unexpired, correctly signed token issued for exactly this order id */
function verifyTrackingToken(token, orderId, nowMs = Date.now()) {
    try {
        const secret = getSecret();
        if (!secret || typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return false;

        const parts = token.split('.');
        if (parts.length !== 3) return false;
        const [id, expRaw, signature] = parts;

        if (id !== String(orderId)) return false;
        if (!/^\d{1,12}$/.test(expRaw)) return false;
        const exp = Number(expRaw);
        if (exp * 1000 < nowMs) return false;

        const expected = Buffer.from(sign(secret, id, exp));
        const received = Buffer.from(signature);
        return expected.length === received.length && crypto.timingSafeEqual(expected, received);
    } catch (_err) {
        return false;
    }
}

function trackingTokenFromRequest(req) {
    const value = req.headers[TRACKING_HEADER];
    return typeof value === 'string' && value.length <= MAX_TOKEN_LENGTH ? value : undefined;
}

module.exports = { createTrackingToken, verifyTrackingToken, trackingTokenFromRequest, TRACKING_HEADER, TTL_SECONDS };
