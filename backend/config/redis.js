const { createClient } = require('redis');

/**
 * Optional shared Redis (REDIS_URL). When it is set:
 *   - Socket.IO rooms/broadcasts work ACROSS Vercel instances (@socket.io/redis-adapter),
 *     so "order shipped" pushes and "X viewing" counts stay correct;
 *   - rate limits are shared by every instance instead of being per-instance.
 * When it is NOT set everything still works, but per instance only (fine for local
 * development and low traffic; see VERCEL_DEPLOYMENT.md).
 */
let client = null;

function getRedis() {
    if (!process.env.REDIS_URL) return null;
    if (client) return client;

    client = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 5000) },
    });
    client.on('error', (err) => console.error('Redis error:', err.message));
    client.connect().catch((err) => console.error('Redis connect failed:', err.message));
    return client;
}

/** A separate connection (pub/sub needs dedicated ones). */
function duplicateRedis() {
    const base = getRedis();
    if (!base) return null;
    const copy = base.duplicate();
    copy.on('error', (err) => console.error('Redis (pub/sub) error:', err.message));
    copy.connect().catch((err) => console.error('Redis (pub/sub) connect failed:', err.message));
    return copy;
}

module.exports = { getRedis, duplicateRedis };
