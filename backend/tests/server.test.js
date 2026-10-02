// The REAL server.js (helmet, CORS, rate limits, error handler, Stripe raw body) as it runs on Vercel.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.VERCEL = '1'; // production behaviour: strict CORS, trust proxy; server.js itself calls listen(PORT) here
process.env.PORT = '0'; // ...on a random free port
process.env.JWT_SECRET = 'test-secret';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_testsecret';
process.env.CLIENT_ORIGIN = '';
process.env.CRON_SECRET = 'cron-secret';

const { installFakes, newId, BACKEND } = require('./helpers/fakes');
installFakes();
// server.js needs the real socket module's initSocket to exist; the fakes provide a no-op one
const server = require('../server');
const realStripe = require(path.join(BACKEND, 'node_modules/stripe'))('sk_test_dummy');

let base;
test.before(async () => {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const call = (method, url, { headers = {}, body, raw } = {}) =>
    fetch(base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined });

test('helmet security headers are present and X-Powered-By is gone', async () => {
    const res = await call('GET', '/');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(res.headers.get('strict-transport-security'));
    assert.equal(res.headers.get('x-powered-by'), null);
});

test('CORS in production: foreign origins get no CORS headers, same origin does', async () => {
    const evil = await call('GET', '/', { headers: { origin: 'https://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const host = base.replace('http://', '');
    const same = await call('GET', '/', { headers: { origin: `http://${host}` } });
    assert.equal(same.headers.get('access-control-allow-origin'), `http://${host}`);
    const preflight = await call('OPTIONS', '/api/orders', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});

test('malformed JSON and oversized bodies are client errors (4xx), not crashes', async () => {
    const bad = await call('POST', '/api/auth/login', { headers: { 'content-type': 'application/json' }, raw: '{"email": ' });
    assert.equal(bad.status, 400);
    const big = await call('POST', '/api/auth/login', { headers: { 'content-type': 'application/json' }, raw: JSON.stringify({ email: 'a'.repeat(300 * 1024) }) });
    assert.equal(big.status, 413);
});

test('NoSQL-operator style bodies are rejected before touching the database', async () => {
    const login = await call('POST', '/api/auth/login', { body: { email: { $gt: '' }, password: { $gt: '' } } });
    assert.equal(login.status, 400);
    const reset = await call('POST', '/api/auth/reset-password', { body: { token: { $ne: null }, password: 'longenough1' } });
    assert.equal(reset.status, 400);
    const verify = await call('GET', '/api/auth/verify-email?token[$ne]=x');
    assert.equal(verify.status, 400);
});

test('public-config exposes only the two PUBLIC social-login ids', async () => {
    process.env.GOOGLE_CLIENT_ID = 'gid.apps.googleusercontent.com';
    process.env.FACEBOOK_APP_ID = '12345';
    process.env.FACEBOOK_APP_SECRET = 'must-never-leak';
    const res = await call('GET', '/api/auth/public-config');
    const json = await res.json();
    assert.deepEqual(json, { googleClientId: 'gid.apps.googleusercontent.com', facebookAppId: '12345' });
    assert.equal(JSON.stringify(json).includes('must-never-leak'), false);
});

test('Stripe webhook keeps working through the full middleware stack (raw body + signature)', async () => {
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'charge.refunded', data: { object: {} } });
    const sig = realStripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_testsecret' });
    const ok = await call('POST', '/api/payments/stripe/webhook', { headers: { 'content-type': 'application/json', 'stripe-signature': sig }, raw: payload });
    assert.equal(ok.status, 200);
    const tampered = await call('POST', '/api/payments/stripe/webhook', { headers: { 'content-type': 'application/json', 'stripe-signature': sig }, raw: payload.replace('evt_1', 'evt_2') });
    assert.equal(tampered.status, 400);
    assert.equal((await tampered.json()).message.includes('whsec'), false);
});

test('cron endpoint still requires the secret', async () => {
    assert.equal((await call('GET', '/api/cron/cancel-abandoned-orders')).status, 401);
});

test('admin and upload-signing routes reject anonymous callers', async () => {
    for (const [m, u] of [['GET', '/api/orders/admin/all'], ['GET', '/api/admin/stats'], ['POST', '/api/upload/sign']]) {
        const r = await call(m, u, m === 'POST' ? { body: { scope: 'product' } } : {});
        assert.equal(r.status, 401, `${m} ${u}`);
    }
});

test('rate limiting: repeated login attempts get 429 (checked last - it exhausts the limiter)', async () => {
    let last;
    for (let i = 0; i < 25; i += 1) last = await call('POST', '/api/auth/login', { body: { email: 'x', password: 'y' } });
    assert.equal(last.status, 429);
    assert.match((await last.json()).message, /Too many/);
    // the Stripe webhook is never throttled, even with the API limiter exhausted elsewhere
    const payload = JSON.stringify({ id: 'evt_3', object: 'event', type: 'charge.refunded', data: { object: {} } });
    const sig = realStripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_testsecret' });
    for (let i = 0; i < 5; i += 1) {
        const r = await call('POST', '/api/payments/stripe/webhook', { headers: { 'content-type': 'application/json', 'stripe-signature': sig }, raw: payload });
        assert.equal(r.status, 200);
    }
});
