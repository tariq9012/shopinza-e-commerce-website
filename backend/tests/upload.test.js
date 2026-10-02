// Legacy multipart uploads (per-endpoint limits) + the direct-to-Cloudinary signing endpoint.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.JWT_SECRET = 'test-secret';
process.env.CLOUDINARY_CLOUD_NAME = 'democloud';
process.env.CLOUDINARY_API_KEY = 'key123';
process.env.CLOUDINARY_API_SECRET = 'sekret';

const { installFakes, newId } = require('./helpers/fakes');
const fakes = installFakes();
const { state } = fakes;

const express = require('express');
const jwt = require('jsonwebtoken');
const uploadRoutes = require('../routes/uploadRoutes');
const { MAX_REQUEST_BYTES } = require('../middleware/upload');

const app = express();
app.use(express.json());
app.use('/api/upload', uploadRoutes);

let server; let base;
test.before(async () => { server = http.createServer(app); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

const ADMIN = newId(); const USER = newId(); const USER2 = newId();
state.users.push({ _id: ADMIN, role: 'admin' }, { _id: USER, role: 'user' }, { _id: USER2, role: 'user' });
const auth = (id) => ({ authorization: `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })}` });

const png = (bytes) => new Blob([Buffer.alloc(bytes, 1)], { type: 'image/png' });
function form(field, count, bytes = 1000, type = 'image/png') {
    const fd = new FormData();
    for (let i = 0; i < count; i += 1) fd.append(field, new Blob([Buffer.alloc(bytes, 1)], { type }), `f${i}.png`);
    return fd;
}
async function send(url, body, headers) {
    const res = await fetch(base + url, { method: 'POST', headers, body });
    let json = {}; try { json = await res.json(); } catch (_e) { /* */ }
    return { status: res.status, json };
}

/* ---------------- legacy endpoints keep working, each with ITS OWN limits ---------------- */
test('gallery endpoint: up to 6 images work (NOT limited to 1), a 7th is refused', async () => {
    const ok = await send('/api/upload/multiple', form('images', 6), auth(ADMIN));
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.images.length, 6);
    const tooMany = await send('/api/upload/multiple', form('images', 7), auth(ADMIN));
    assert.equal(tooMany.status, 400);
});

test('review endpoint: up to 4 images work (any signed-in user), a 5th is refused', async () => {
    const ok = await send('/api/upload/review', form('images', 4), auth(USER));
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.images.length, 4);
    assert.ok(ok.json.images.every((i) => i.url.includes('shopinza/reviews')));
    assert.equal((await send('/api/upload/review', form('images', 5), auth(USER))).status, 400);
});

test('single-image endpoint: exactly one image; a second is refused', async () => {
    const ok = await send('/api/upload', form('image', 1), auth(ADMIN));
    assert.equal(ok.status, 201);
    assert.ok(ok.json.url);
    assert.equal((await send('/api/upload', form('image', 2), auth(ADMIN))).status, 400);
});

test('legacy endpoints: auth rules, file type, and per-file size are enforced', async () => {
    assert.equal((await send('/api/upload/multiple', form('images', 1))).status, 401);
    assert.equal((await send('/api/upload/multiple', form('images', 1), auth(USER))).status, 403); // gallery is admin-only
    assert.equal((await send('/api/upload/review', form('images', 1))).status, 401);
    assert.equal((await send('/api/upload/review', form('images', 1, 1000, 'application/pdf'), auth(USER))).status, 400);
    const huge = new FormData(); huge.append('images', png(4 * 1024 * 1024 + 1), 'big.png');
    assert.equal((await send('/api/upload/review', huge, auth(USER))).status, 400);
});

test('legacy endpoints: a whole request above the Vercel-safe size is rejected BEFORE buffering (413)', async () => {
    assert.ok(MAX_REQUEST_BYTES < 4.5 * 1024 * 1024, 'the cap must sit below Vercel\'s ~4.5 MB body limit');
    before: {
        const uploadsBefore = state.calls.cloudinary.length;
        const r = await send('/api/upload/multiple', form('images', 5, 1024 * 1024), auth(ADMIN)); // 5 x 1 MB = ~5 MB total
        assert.equal(r.status, 413);
        assert.match(r.json.message, /too large/i);
        assert.equal(state.calls.cloudinary.length, uploadsBefore, 'nothing was sent to Cloudinary');
        break before;
    }
    // just under the cap is still accepted (several smaller images)
    assert.equal((await send('/api/upload/multiple', form('images', 4, 900 * 1024), auth(ADMIN))).status, 201);
});

/* ---------------- direct Cloudinary signing ---------------- */
test('sign: product scope is admin-only, review scope needs a login, unknown scope is refused', async () => {
    const j = { 'content-type': 'application/json' };
    const post = (scope, headers = {}) => send('/api/upload/sign', JSON.stringify({ scope }), { ...j, ...headers });
    assert.equal((await post('product')).status, 401);
    assert.equal((await post('product', auth(USER))).status, 403);
    assert.equal((await post('bogus', auth(USER))).status, 400);
    const ok = await post('product', auth(ADMIN));
    assert.equal(ok.status, 200);
    assert.equal(ok.json.folder, 'shopinza/products');
    assert.equal(ok.json.allowed_formats, 'jpg,jpeg,png,webp,gif');
    assert.equal(ok.json.apiKey, 'key123');
    assert.ok(ok.json.signature);
    assert.match(ok.json.uploadUrl, /democloud\/image\/upload$/);
    assert.equal(JSON.stringify(ok.json).includes('sekret'), false, 'the API secret never leaves the server');
    const review = await post('review', auth(USER));
    assert.equal(review.json.folder, 'shopinza/reviews');
});

test('sign: the endpoint is rate-limited PER USER (review scope 20/hour), other users unaffected', async () => {
    const post = (headers) => send('/api/upload/sign', JSON.stringify({ scope: 'review' }), { 'content-type': 'application/json', ...headers });
    const statuses = [];
    for (let i = 0; i < 22; i += 1) statuses.push((await post(auth(USER2))).status);
    assert.equal(statuses.slice(0, 20).every((s) => s === 200), true, statuses.join());
    assert.deepEqual(statuses.slice(20), [429, 429]);
    assert.equal((await post(auth(USER))).status, 200, 'a different user has their own allowance');
});

test('sign: does NOT claim a server-enforced size limit (Cloudinary offers no such signed parameter)', async () => {
    const r = await send('/api/upload/sign', JSON.stringify({ scope: 'product' }), { 'content-type': 'application/json', ...auth(ADMIN) });
    const keys = Object.keys(r.json);
    assert.equal(keys.some((k) => /size|bytes|max/i.test(k)), false, keys.join());
});
