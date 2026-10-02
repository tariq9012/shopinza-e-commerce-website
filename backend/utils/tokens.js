const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// ---------- Access / refresh tokens (login sessions) ----------
//
// Short-lived access token: sent on every request, expires quickly so a
// stolen one is only useful for a short window.
// Long-lived refresh token: stored by the frontend and only ever sent to
// POST /api/auth/refresh to silently obtain a new access token, so the user
// isn't forced to log in again every few minutes like the old single-7-day
// token did.

const ACCESS_TOKEN_EXPIRES_IN = '15m';
const REFRESH_TOKEN_EXPIRES_IN = '30d';

function signAccessToken(userId) {
    return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRES_IN, algorithm: 'HS256' });
}

function signRefreshToken(userId, tokenVersion) {
    return jwt.sign({ userId, tokenVersion }, process.env.JWT_REFRESH_SECRET, {
        expiresIn: REFRESH_TOKEN_EXPIRES_IN,
    });
}

/** Throws if the refresh token is missing/invalid/expired. */
function verifyRefreshToken(token) {
    return jwt.verify(token, process.env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
}

// ---------- One-time link tokens (email verification, password reset) ----------
//
// We only ever store a SHA-256 hash of these in the database - never the raw
// value - the same way passwords are hashed. That way, even if the database
// leaked, nobody could use the stored value to verify/reset an account; only
// the raw token emailed to the user's inbox works.

function generateRawToken() {
    return crypto.randomBytes(32).toString('hex');
}

function hashToken(rawToken) {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
}

module.exports = {
    signAccessToken,
    signRefreshToken,
    verifyRefreshToken,
    generateRawToken,
    hashToken,
};
