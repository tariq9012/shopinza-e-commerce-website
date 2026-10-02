const crypto = require('crypto');
const express = require('express');
const { cancelAbandonedOrders } = require('../jobs/cancelAbandonedOrders');

const router = express.Router();

/**
 * Vercel Cron calls this with:  Authorization: Bearer <CRON_SECRET>
 * (Vercel sends it automatically when a CRON_SECRET env variable exists.)
 * Fails CLOSED: with no CRON_SECRET configured the endpoint refuses everyone,
 * so it can never be triggered anonymously.
 */
function requireCronSecret(req, res, next) {
    const secret = process.env.CRON_SECRET;

    if (!secret) {
        return res.status(503).json({ message: 'CRON_SECRET is not configured.' });
    }

    const expected = Buffer.from(`Bearer ${secret}`);
    const received = Buffer.from(req.get('authorization') || '');

    // constant-time comparison (lengths must match first or timingSafeEqual throws)
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
        return res.status(401).json({ message: 'Unauthorized.' });
    }

    next();
}

// GET /api/cron/cancel-abandoned-orders
// Same cleanup logic that used to run on setInterval (jobs/cancelAbandonedOrders.js).
router.get('/cancel-abandoned-orders', requireCronSecret, async (_req, res) => {
    try {
        const result = await cancelAbandonedOrders();
        res.json({ ok: true, ...result });
    } catch (err) {
        console.error('Abandoned-order cron error:', err);
        res.status(500).json({ ok: false, message: 'Cleanup failed.' });
    }
});

module.exports = router;
