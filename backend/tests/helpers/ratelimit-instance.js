// One "Vercel instance" running the REAL rate limiter (middleware/rateLimits.js) on a tiny app.
// Started by tests/redis.test.js; REDIS_URL decides whether counters are shared.
const path = require('path');
const http = require('http');
const express = require('express');
const B = path.resolve(__dirname, '..', '..');
const { authLimiter } = require(path.join(B, 'middleware/rateLimits'));

const app = express();
app.post('/login', authLimiter, (_req, res) => res.json({ ok: true, pid: process.pid }));
const server = http.createServer(app);
server.listen(process.env.PORT, () => process.send && process.send('ready'));
