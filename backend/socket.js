const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { createAdapter } = require('@socket.io/redis-adapter');
const connectDB = require('./config/db');
const { duplicateRedis, getRedis } = require('./config/redis');
const Order = require('./models/Order');
const { canViewOrder, isValidObjectId } = require('./utils/orderAccess');
const { isAllowedOrigin } = require('./utils/origins');

let io = null;

const MAX_ORDER_ROOMS_PER_SOCKET = 25;
const MAX_SLUG_LENGTH = 200;

/**
 * Wires up Socket.io on top of the existing HTTP server (same port as the
 * REST API - no separate server/port needed). Called once from server.js.
 *
 * With REDIS_URL set, the Redis adapter makes rooms and broadcasts work across
 * ALL server instances (a status change handled by instance A reaches a customer
 * connected to instance B). Without it, events only reach sockets on the same instance.
 */
function initSocket(server) {
    io = new Server(server, {
        // Same rules as the REST CORS (utils/origins.js): same-origin + CLIENT_ORIGIN only in production.
        cors: { origin: (origin, cb) => cb(null, isAllowedOrigin(origin)), credentials: true },
        // WebSocket upgrades ignore CORS headers, so the Origin is checked explicitly.
        allowRequest: (req, cb) => cb(null, isAllowedOrigin(req.headers.origin, req.headers)),
        maxHttpBufferSize: 10 * 1024, // events here are tiny - refuse big payloads
    });

    if (getRedis()) {
        const pub = duplicateRedis();
        const sub = duplicateRedis();
        io.adapter(createAdapter(pub, sub));
        console.log('Socket.IO: Redis adapter enabled (cross-instance realtime).');
    }

    io.on('connection', (socket) => {
        // ---------- Live order tracking ----------
        // A customer viewing an order joins its room. Joining is AUTHORISED: the
        // caller must be the signed-in owner or hold the order's access token, so
        // nobody can watch an order just by knowing its id.
        // payload: { orderId, orderToken?, trackingToken?, jwt? }   ack: { ok, reason? }
        // (a signed emailed trackingToken is READ-ONLY: it lets a guest follow the order's live status)
        socket.on('order:join', async (payload, ack) => {
            const reply = typeof ack === 'function' ? ack : () => {};
            try {
                const orderId = payload && payload.orderId;
                if (typeof orderId !== 'string' || !isValidObjectId(orderId)) return reply({ ok: false, reason: 'invalid-order' });

                const already = [...socket.rooms].filter((r) => r.startsWith('order:')).length;
                if (already >= MAX_ORDER_ROOMS_PER_SOCKET) return reply({ ok: false, reason: 'too-many-orders' });

                let userId;
                if (typeof payload.jwt === 'string' && payload.jwt) {
                    try {
                        userId = jwt.verify(payload.jwt, process.env.JWT_SECRET, { algorithms: ['HS256'] }).userId;
                    } catch (_err) {
                        userId = undefined; // expired/invalid - fall back to the order token
                    }
                }

                await connectDB();
                const order = await Order.findById(orderId).select('user accessTokenHash');
                const token = typeof payload.orderToken === 'string' ? payload.orderToken.slice(0, 128) : undefined;

                const trackingToken = typeof payload.trackingToken === 'string' ? payload.trackingToken.slice(0, 200) : undefined;

                if (!canViewOrder(order, { userId, token, trackingToken })) return reply({ ok: false, reason: 'not-allowed' });

                socket.join(`order:${orderId}`);
                reply({ ok: true });
            } catch (err) {
                console.error('order:join error:', err.message);
                reply({ ok: false, reason: 'error' });
            }
        });

        socket.on('order:leave', (orderId) => {
            if (typeof orderId === 'string' && orderId.length <= 40) socket.leave(`order:${orderId}`);
        });

        // ---------- "X people viewing this product" ----------
        socket.on('product:join', (slug) => {
            if (typeof slug !== 'string' || !slug || slug.length > MAX_SLUG_LENGTH) return;
            socket.join(`product:${slug}`);
            broadcastProductViewers(slug);
        });
        socket.on('product:leave', (slug) => {
            if (typeof slug !== 'string' || !slug || slug.length > MAX_SLUG_LENGTH) return;
            socket.leave(`product:${slug}`);
            broadcastProductViewers(slug); // socket.leave() updates room membership synchronously, safe to broadcast right away
        });

        // Also handles someone just closing the tab (no explicit "leave"
        // event fired) - 'disconnecting' still sees which rooms they were in.
        socket.on('disconnecting', () => {
            const productRooms = [...socket.rooms].filter((room) => room.startsWith('product:'));
            if (productRooms.length === 0) return;
            // wait a tick so the socket has actually left the rooms before counting
            setImmediate(() => productRooms.forEach((room) => broadcastProductViewers(room.slice('product:'.length))));
        });
    });

    return io;
}

/** Counts viewers across ALL instances when the Redis adapter is on (fetchSockets is cluster-aware). */
async function broadcastProductViewers(slug) {
    if (!io) return;
    const room = `product:${slug}`;
    try {
        const sockets = await io.in(room).fetchSockets();
        io.to(room).emit('product:viewers', { slug, count: sockets.length });
    } catch (err) {
        console.error('product viewers error:', err.message);
    }
}

/** Call this after an order's status changes, from wherever that happens (admin status update, self-cancel, payment confirmation). */
function emitOrderUpdate(order) {
    if (!io) return;
    io.to(`order:${order._id}`).emit('order:updated', {
        orderId: String(order._id),
        status: order.status,
    });
}

function getIO() {
    return io;
}

module.exports = { initSocket, getIO, emitOrderUpdate };
