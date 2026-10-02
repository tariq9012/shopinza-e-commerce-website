const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { getRedis } = require('../config/redis');

/**
 * Rate limiters. With REDIS_URL the counters are shared by every Vercel
 * instance; without it each instance keeps its own (weaker, but still stops a
 * single-instance brute force and costs nothing).
 */
function makeLimiter(name, { windowMs, limit, message, keyGenerator }) {
    const redis = getRedis();

    return rateLimit({
        windowMs,
        limit,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        ...(keyGenerator ? { keyGenerator } : {}),
        message: { message: message || 'Too many requests. Please wait a bit and try again.' },
        ...(redis
            ? { store: new RedisStore({ prefix: `rl:${name}:`, sendCommand: (...args) => redis.sendCommand(args) }) }
            : {}),
    });
}

const MINUTE = 60 * 1000;

// Cloudinary signatures are handed out per signed-in USER (not per IP): a review author can ask for a few
// signatures an hour, an admin many more. Keyed by user id, so shared IPs don't punish each other.
function uploadSignLimiterFor(scope) {
    return makeLimiter(`upload-sign-${scope}`, {
        windowMs: 60 * MINUTE,
        limit: scope === 'review' ? 20 : 300,
        message: 'Too many image upload requests. Please try again later.',
        keyGenerator: (req) => `u:${req.userId || 'anon'}`,
    });
}

module.exports = {
    uploadSignLimiterFor,
    // every /api request (generous - only stops floods)
    apiLimiter: makeLimiter('api', { windowMs: MINUTE, limit: 300 }),
    // login / register / password reset / social login: slow down guessing + email bombing
    authLimiter: makeLimiter('auth', {
        windowMs: 15 * MINUTE,
        limit: 20,
        message: 'Too many attempts. Please wait 15 minutes and try again.',
    }),
    // placing orders reserves stock, so cap how fast one client can do it
    orderCreateLimiter: makeLimiter('order-create', {
        windowMs: 60 * MINUTE,
        limit: 20,
        message: 'Too many orders from this connection. Please try again later.',
    }),
    paymentLimiter: makeLimiter('payment', { windowMs: 15 * MINUTE, limit: 60 }),
    // public forms that send email / write to the DB
    formLimiter: makeLimiter('form', {
        windowMs: 60 * MINUTE,
        limit: 10,
        message: 'Too many submissions. Please try again later.',
    }),
};
