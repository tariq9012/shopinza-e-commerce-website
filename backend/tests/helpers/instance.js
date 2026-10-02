// One "Vercel instance": its own process running the REAL socket.js against a shared Redis.
// Only the DB is faked (one known order). Started by tests/redis.test.js.
const path = require('path');
const http = require('http');
const express = require('express');
const B = path.resolve(__dirname, '..', '..');
const stub = (rel, exports) => { const f = require.resolve(path.join(B, rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports, children: [], paths: [] }; };

const { generateOrderAccessToken } = require(path.join(B, 'utils/orderAccess'));
const { createTrackingToken } = require(path.join(B, 'utils/orderTracking'));
const ORDER_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const { token, hash } = generateOrderAccessToken();
stub('config/db.js', async () => {});
stub('models/Order.js', { findById: () => ({ select: async () => ({ _id: ORDER_ID, user: undefined, accessTokenHash: hash }) }) });

const { initSocket, emitOrderUpdate } = require(path.join(B, 'socket.js'));
const app = express();
app.post('/emit/:status', (req, res) => { emitOrderUpdate({ _id: ORDER_ID, status: req.params.status }); res.json({ ok: true, pid: process.pid }); });
app.get('/info', (_req, res) => res.json({ token, trackingToken: createTrackingToken(ORDER_ID), orderId: ORDER_ID, pid: process.pid }));
const server = http.createServer(app);
initSocket(server);
server.listen(process.env.PORT, () => process.send && process.send('ready'));
