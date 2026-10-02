// Cross-instance realtime, tested against a REAL Redis. Skipped when TEST_REDIS_URL is not set.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const path = require('node:path');
const { io } = require('socket.io-client');

const REDIS_URL = process.env.TEST_REDIS_URL;
const skip = !REDIS_URL && 'set TEST_REDIS_URL=redis://127.0.0.1:6379 to run';

function startInstance(port, redisUrl) {
    return new Promise((resolve, reject) => {
        const child = fork(path.join(__dirname, 'helpers/instance.js'), [], {
            env: { ...process.env, PORT: String(port), JWT_SECRET: 'x', ORDER_TRACKING_SECRET: 'redis-test-tracking-secret', ...(redisUrl ? { REDIS_URL: redisUrl } : {}) },
            stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        child.once('message', () => resolve(child));
        child.once('error', reject);
        setTimeout(() => reject(new Error('instance start timeout')), 8000);
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = (port) => new Promise((res, rej) => { const s = io(`http://127.0.0.1:${port}`, { transports: ['websocket'] }); s.on('connect', () => res(s)); s.on('connect_error', rej); });
const emitAck = (s, ev, payload) => new Promise((res) => s.emit(ev, payload, res));

async function scenario(redisUrl) {
    const [a, b] = [await startInstance(5601, redisUrl), await startInstance(5602, redisUrl)];
    const info = await (await fetch('http://127.0.0.1:5601/info')).json();
    const cleanup = [];
    try {
        // customer connected to instance A, guest order token
        const customer = await connect(5601); cleanup.push(customer);
        const denied = await emitAck(customer, 'order:join', { orderId: info.orderId, orderToken: 'f'.repeat(64) });
        const allowed = await emitAck(customer, 'order:join', { orderId: info.orderId, orderToken: info.token });
        const updates = [];
        customer.on('order:updated', (u) => updates.push(u.status));

        // the admin's HTTP request lands on instance B
        await fetch('http://127.0.0.1:5602/emit/shipped', { method: 'POST' });
        await sleep(400);

        // two viewers of the same product, one on each instance
        const v1 = await connect(5601); const v2 = await connect(5602); cleanup.push(v1, v2);
        const counts = [];
        v1.on('product:viewers', (m) => counts.push(m.count));
        v1.emit('product:join', 'shirt'); await sleep(200);
        v2.emit('product:join', 'shirt'); await sleep(500);
        return { denied, allowed, updates, counts };
    } finally {
        cleanup.forEach((s) => s.close());
        a.kill(); b.kill();
        await sleep(200);
    }
}

test('WITH Redis: an order update from instance B reaches a customer on instance A; viewer counts are global', { skip }, async () => {
    const r = await scenario(REDIS_URL);
    assert.deepEqual(r.denied, { ok: false, reason: 'not-allowed' }, 'wrong token must not join the room');
    assert.deepEqual(r.allowed, { ok: true });
    assert.deepEqual(r.updates, ['shipped']);
    assert.ok(r.counts.includes(2), `viewer count across both instances should reach 2, got ${JSON.stringify(r.counts)}`);
});

test('WITHOUT Redis (control): the same update is MISSED - which is why Redis is needed', { skip: false }, async () => {
    const r = await scenario(undefined);
    assert.deepEqual(r.allowed, { ok: true });
    assert.deepEqual(r.updates, [], 'without Redis the event stays on instance B');
    assert.ok(!r.counts.includes(2), `without Redis counts stay per-instance, got ${JSON.stringify(r.counts)}`);
});

/* ---------------- read-only emailed tracking token over Socket.IO ---------------- */
test('socket: a valid emailed tracking token may follow live status; a forged/other-order one may not', { skip }, async () => {
    const a = await startInstance(5603, REDIS_URL);
    const sockets = [];
    try {
        const info = await (await fetch('http://127.0.0.1:5603/info')).json();
        const s = await connect(5603); sockets.push(s);
        const forged = info.trackingToken.slice(0, -3) + 'abc';
        const otherOrder = info.trackingToken.replace(info.orderId, 'b'.repeat(24));
        assert.deepEqual(await emitAck(s, 'order:join', { orderId: info.orderId, trackingToken: forged }), { ok: false, reason: 'not-allowed' });
        assert.deepEqual(await emitAck(s, 'order:join', { orderId: info.orderId, trackingToken: otherOrder }), { ok: false, reason: 'not-allowed' });
        assert.deepEqual(await emitAck(s, 'order:join', { orderId: info.orderId }), { ok: false, reason: 'not-allowed' });
        assert.deepEqual(await emitAck(s, 'order:join', { orderId: info.orderId, trackingToken: info.trackingToken }), { ok: true });
        const updates = [];
        s.on('order:updated', (u) => updates.push(u.status));
        await fetch('http://127.0.0.1:5603/emit/delivered', { method: 'POST' });
        await sleep(300);
        assert.deepEqual(updates, ['delivered']);
    } finally { sockets.forEach((x) => x.close()); a.kill(); await sleep(150); }
});

/* ---------------- rate limits shared across instances (two REAL processes) ---------------- */
function startLimiter(port, redisUrl) {
    return new Promise((resolve, reject) => {
        const child = fork(path.join(__dirname, 'helpers/ratelimit-instance.js'), [], {
            env: { ...process.env, PORT: String(port), ...(redisUrl ? { REDIS_URL: redisUrl } : { REDIS_URL: '' }) },
            stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        });
        child.once('message', () => resolve(child));
        child.once('error', reject);
        setTimeout(() => reject(new Error('limiter instance start timeout')), 8000);
    });
}

async function clearRateLimitKeys() {
    const { createClient } = require('redis');
    const c = createClient({ url: REDIS_URL });
    await c.connect();
    const keys = await c.keys('rl:*');
    if (keys.length) await c.del(keys);
    await c.quit();
}

async function hammer() {
    // 24 login attempts alternating between the two processes; the limit is 20 per window
    const statuses = [];
    for (let i = 0; i < 24; i += 1) {
        const port = i % 2 === 0 ? 5611 : 5612;
        statuses.push((await fetch(`http://127.0.0.1:${port}/login`, { method: 'POST' })).status);
    }
    return statuses;
}

test('rate limit WITH Redis: the 20/15min limit is SHARED by both instances (attempts 21-24 -> 429)', { skip }, async () => {
    await clearRateLimitKeys();
    const [a, b] = [await startLimiter(5611, REDIS_URL), await startLimiter(5612, REDIS_URL)];
    try {
        const statuses = await hammer();
        assert.deepEqual(statuses.slice(0, 20), Array(20).fill(200), statuses.join());
        assert.deepEqual(statuses.slice(20), [429, 429, 429, 429], statuses.join());
    } finally { a.kill(); b.kill(); await sleep(150); await clearRateLimitKeys(); }
});

test('rate limit WITHOUT Redis (control): each instance counts alone, so 24 alternating attempts all pass', async () => {
    const [a, b] = [await startLimiter(5611, undefined), await startLimiter(5612, undefined)];
    try {
        const statuses = await hammer();
        assert.deepEqual(statuses, Array(24).fill(200), `without a shared store nothing is throttled yet: ${statuses.join()}`);
    } finally { a.kill(); b.kill(); await sleep(150); }
});
