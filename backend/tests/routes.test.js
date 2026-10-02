const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

process.env.JWT_SECRET = 'test-secret';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_testsecret';
process.env.JAZZCASH_INTEGRITY_SALT = 'jazz-salt';
process.env.EASYPAISA_HASH_KEY = 'ep-key';
process.env.FRONTEND_URL = 'http://site.test';
process.env.ORDER_TRACKING_SECRET = 'tracking-test-secret';
process.env.USD_TO_PKR_RATE = '280'; // deliberate server-side rate: $49.99 -> PKR 13,997.20

const { installFakes, newId, BACKEND } = require('./helpers/fakes');

// ----- fake Stripe API (webhook signature helpers stay real) -----
const stripeCalls = { create: 0 };
const stripeState = { intents: {} };
const realStripe = require(path.join(BACKEND, 'node_modules/stripe'))('sk_test_dummy');
const stripeFake = {
    webhooks: realStripe.webhooks,
    paymentIntents: {
        retrieve: async (id) => stripeState.intents[id],
        create: async ({ amount, metadata }) => {
            stripeCalls.create += 1;
            const pi = { id: `pi_${stripeCalls.create}`, status: 'requires_payment_method', amount, currency: 'usd', metadata, client_secret: `secret_${stripeCalls.create}` };
            stripeState.intents[pi.id] = pi;
            return pi;
        },
    },
};

const fakes = installFakes({ stripe: stripeFake });
const { state } = fakes;

const express = require('express');
const jwt = require('jsonwebtoken');
const orderRoutes = require('../routes/orderRoutes');
const paymentRoutes = require('../routes/paymentRoutes');
const { generateSecureHash } = require('../utils/secureHash');

const app = express();
app.use('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);

let server;
let base;
test.before(async () => {
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const jwtFor = (userId) => jwt.sign({ userId }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
const USERS = { owner: newId(), other: newId(), admin: newId() };
state.users.push({ _id: USERS.owner, role: 'user' }, { _id: USERS.other, role: 'user' }, { _id: USERS.admin, role: 'admin' });

function seed() {
    state.products.length = 0;
    state.orders.length = 0;
    state.coupons.length = 0;
    state.calls.emails.length = 0;
    state.calls.emits.length = 0;
    state.calls.productInc.length = 0;
    state.calls.couponInc.length = 0;
    stripeCalls.create = 0;
    for (const k of Object.keys(stripeState.intents)) delete stripeState.intents[k];
    state.products.push(
        { slug: 'shirt', name: 'Shirt', price: 49.99, image: 'https://img/shirt.jpg', stock: 10, variants: [] },
        { slug: 'tee', name: 'Tee', price: 20, image: 'https://img/tee.jpg', stock: 5, variants: [{ color: 'Red', size: 'M', stock: 5 }] }
    );
    state.coupons.push({ _id: newId(), code: 'SAVE10', type: 'percent', value: 10, active: true, usedCount: 0, minOrderValue: 0 });
}

async function call(method, url, { body, headers = {}, raw, redirect } = {}) {
    const res = await fetch(base + url, {
        method,
        redirect: redirect || 'follow',
        headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
        body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch (_e) { /* redirects / empty */ }
    return { status: res.status, json, headers: res.headers };
}

const SHIP = { firstName: 'Ali', lastName: 'Khan', email: 'ali@example.com', address: '1 Road', city: 'Isb', state: 'ICT', zip: '44000' };
const auth = (userId) => ({ authorization: `Bearer ${jwtFor(userId)}` });

async function placeOrder({ items = [{ productId: 'shirt', qty: 1 }], user, paymentMethod = 'stripe', extra = {} } = {}) {
    return call('POST', '/api/orders', { body: { items, shipping: SHIP, shippingMethod: 'standard', paymentMethod, ...extra }, headers: user ? auth(user) : {} });
}

/* ================= checkout: prices come from the server ================= */
test('price tampering: client-sent price/total/discount are ignored', async () => {
    seed();
    const res = await placeOrder({ items: [{ productId: 'shirt', qty: 2, price: 0.01, name: 'FREE', image: 'x' }], extra: { total: 0.02, subtotal: 0.02, discount: 999, shippingCost: 0 } });
    assert.equal(res.status, 201);
    assert.equal(res.json.order.items[0].price, 49.99);
    assert.equal(res.json.order.items[0].name, 'Shirt');
    assert.equal(res.json.order.subtotal, 99.98);
    assert.equal(res.json.order.total, 99.98);
    assert.equal(res.json.order.discount, 0);
    assert.equal(state.products[0].stock, 8);
});

test('checkout returns a one-time access token and never the token hash', async () => {
    seed();
    const res = await placeOrder();
    assert.equal(res.status, 201);
    assert.match(res.json.accessToken, /^[a-f0-9]{64}$/);
    assert.equal('accessTokenHash' in res.json.order, false);
});

test('negative / zero / fractional quantities are rejected and stock is untouched', async () => {
    seed();
    for (const qty of [-3, 0, 1.5, '2']) {
        const res = await placeOrder({ items: [{ productId: 'shirt', qty }] });
        assert.equal(res.status, 400, `qty ${JSON.stringify(qty)}`);
    }
    assert.equal(state.products[0].stock, 10);
    assert.equal(state.orders.length, 0);
});

test('express shipping and coupon are computed on the server', async () => {
    seed();
    const res = await call('POST', '/api/orders', { body: { items: [{ productId: 'tee', qty: 2, color: 'Red', size: 'M' }], shipping: SHIP, shippingMethod: 'express', paymentMethod: 'cod', couponCode: 'save10' } });
    assert.equal(res.status, 201);
    assert.equal(res.json.order.subtotal, 40);
    assert.equal(res.json.order.discount, 4);
    assert.equal(res.json.order.shippingCost, 25);
    assert.equal(res.json.order.total, 61);
    assert.deepEqual(state.calls.couponInc, [1]);
    assert.equal(state.products[1].variants[0].stock, 3);
});

test('unknown product, missing variant, over-stock and bad shipping are refused', async () => {
    seed();
    assert.equal((await placeOrder({ items: [{ productId: 'ghost', qty: 1 }] })).status, 409);
    assert.equal((await placeOrder({ items: [{ productId: 'tee', qty: 1 }] })).status, 409);
    const over = await placeOrder({ items: [{ productId: 'shirt', qty: 11 }] });
    assert.equal(over.status, 409);
    assert.match(over.json.message, /only 10/);
    assert.equal(state.products[0].stock, 10);
    const bad = await call('POST', '/api/orders', { body: { items: [{ productId: 'shirt', qty: 1 }], shipping: { ...SHIP, email: 'nope' } } });
    assert.equal(bad.status, 400);
    const inj = await call('POST', '/api/orders', { body: { items: [{ productId: { $ne: 'x' }, qty: 1 }], shipping: SHIP } });
    assert.equal(inj.status, 400);
});

/* ================= order privacy ================= */
test('GET /api/orders/:id is private: token, owner or admin only', async () => {
    seed();
    const guest = await placeOrder();
    const id = guest.json.order._id;
    const token = guest.json.accessToken;

    assert.equal((await call('GET', `/api/orders/${id}`)).status, 404);
    assert.equal((await call('GET', `/api/orders/${id}`, { headers: { 'x-order-token': 'f'.repeat(64) } })).status, 404);
    assert.equal((await call('GET', `/api/orders/${id}`, { headers: auth(USERS.other) })).status, 404);
    assert.equal((await call('GET', '/api/orders/not-an-id')).status, 404);

    const ok = await call('GET', `/api/orders/${id}`, { headers: { 'x-order-token': token } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.order.shipping.city, 'Isb');
    assert.equal('accessTokenHash' in ok.json.order, false);
    assert.equal((await call('GET', `/api/orders/${id}`, { headers: auth(USERS.admin) })).status, 200);

    const mine = await placeOrder({ user: USERS.owner });
    assert.equal((await call('GET', `/api/orders/${mine.json.order._id}`, { headers: auth(USERS.owner) })).status, 200);
    assert.equal((await call('GET', `/api/orders/${mine.json.order._id}`, { headers: auth(USERS.other) })).status, 404);
});

test('payment endpoints refuse callers who do not own the order', async () => {
    seed();
    const o = await placeOrder();
    const id = o.json.order._id;
    for (const [url, body] of [
        ['/api/payments/stripe/create-intent', { orderId: id }],
        [`/api/payments/stripe/confirm/${id}`, {}],
        ['/api/payments/jazzcash/initiate', { orderId: id }],
        ['/api/payments/easypaisa/initiate', { orderId: id }],
    ]) {
        assert.equal((await call('POST', url, { body })).status, 404, url);
        assert.equal((await call('POST', url, { body, headers: { 'x-order-token': 'a'.repeat(64) } })).status, 404, url);
    }
    assert.equal(stripeCalls.create, 0);
});

/* ================= Stripe ================= */
test('create-intent reuses the open PaymentIntent instead of creating another', async () => {
    seed();
    const o = await placeOrder();
    const headers = { 'x-order-token': o.json.accessToken };
    const a = await call('POST', '/api/payments/stripe/create-intent', { body: { orderId: o.json.order._id }, headers });
    const b = await call('POST', '/api/payments/stripe/create-intent', { body: { orderId: o.json.order._id }, headers });
    assert.equal(a.status, 200);
    assert.equal(a.json.clientSecret, b.json.clientSecret);
    assert.equal(stripeCalls.create, 1);
});

test('Stripe confirm: amount/order mismatch is refused, matching payment marks paid', async () => {
    seed();
    const o = await placeOrder({ items: [{ productId: 'shirt', qty: 1 }] });
    const id = o.json.order._id;
    const headers = { 'x-order-token': o.json.accessToken };
    await call('POST', '/api/payments/stripe/create-intent', { body: { orderId: id }, headers });
    const pi = stripeState.intents.pi_1;

    pi.status = 'succeeded';
    pi.amount = 100; // customer paid $1.00 for a $49.99 order
    const bad = await call('POST', `/api/payments/stripe/confirm/${id}`, { body: {}, headers });
    assert.equal(bad.status, 400);
    assert.equal(state.orders[0].status, 'pending');

    pi.amount = 4999;
    const good = await call('POST', `/api/payments/stripe/confirm/${id}`, { body: {}, headers });
    assert.equal(good.status, 200);
    assert.equal(state.orders[0].status, 'paid');
});

function signedWebhook(pi) {
    const payload = JSON.stringify({ id: `evt_${newId()}`, object: 'event', type: 'payment_intent.succeeded', data: { object: pi } });
    const sig = realStripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    return { payload, sig };
}

test('Stripe webhook: bad signature 400; wrong amount ignored; duplicates and races pay the order ONCE', async () => {
    seed();
    const o = await placeOrder();
    const id = o.json.order._id;
    const headers = { 'x-order-token': o.json.accessToken };
    await call('POST', '/api/payments/stripe/create-intent', { body: { orderId: id }, headers });
    const pi = { ...stripeState.intents.pi_1, status: 'succeeded' };

    const forged = signedWebhook(pi);
    assert.equal((await call('POST', '/api/payments/stripe/webhook', { raw: forged.payload.replace('4999', '1'), headers: { 'content-type': 'application/json', 'stripe-signature': forged.sig } })).status, 400);

    const cheap = signedWebhook({ ...pi, amount: 100 });
    assert.equal((await call('POST', '/api/payments/stripe/webhook', { raw: cheap.payload, headers: { 'content-type': 'application/json', 'stripe-signature': cheap.sig } })).status, 200);
    assert.equal(state.orders[0].status, 'pending', 'underpaid intent must not pay the order');

    stripeState.intents.pi_1.status = 'succeeded';
    const fire = () => {
        const w = signedWebhook(pi);
        return call('POST', '/api/payments/stripe/webhook', { raw: w.payload, headers: { 'content-type': 'application/json', 'stripe-signature': w.sig } });
    };
    const confirm = () => call('POST', `/api/payments/stripe/confirm/${id}`, { body: {}, headers });
    const results = await Promise.all([fire(), fire(), confirm(), fire(), confirm()]);
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(state.orders[0].status, 'paid');
    assert.equal(state.calls.emails.filter((e) => e[0] === 'paid').length, 1, 'exactly one "paid" email');
    assert.equal(state.calls.emits.filter((e) => e[1] === 'paid').length, 1, 'exactly one live push');
});

test('payment that arrives AFTER the order was cancelled is flagged, never silently accepted', async () => {
    seed();
    const o = await placeOrder({ user: USERS.owner });
    const id = o.json.order._id;
    await call('POST', '/api/payments/stripe/create-intent', { body: { orderId: id }, headers: auth(USERS.owner) });
    assert.equal((await call('PATCH', `/api/orders/${id}/cancel`, { headers: auth(USERS.owner) })).status, 200);
    assert.equal(state.products[0].stock, 10);

    const w = signedWebhook({ ...stripeState.intents.pi_1, status: 'succeeded' });
    await call('POST', '/api/payments/stripe/webhook', { raw: w.payload, headers: { 'content-type': 'application/json', 'stripe-signature': w.sig } });
    assert.equal(state.orders[0].status, 'cancelled');
    assert.match(state.orders[0].paymentIssue, /refund/i);
    assert.equal(state.calls.emails.filter((e) => e[0] === 'paid').length, 0);
});

/* ================= JazzCash / Easypaisa ================= */
test('JazzCash callback: forged/underpaid callbacks are rejected, a signed matching one pays', async () => {
    seed();
    const o = await placeOrder({ paymentMethod: 'jazzcash' });
    const id = o.json.order._id;
    process.env.JAZZCASH_MERCHANT_ID = 'MC1';
    const init = await call('POST', '/api/payments/jazzcash/initiate', { body: { orderId: id }, headers: { 'x-order-token': o.json.accessToken } });
    assert.equal(init.status, 200);
    const txn = state.orders[0].paymentIntentId;
    assert.equal(init.json.fields.pp_Amount, '1399720', 'JazzCash is asked for the PKR quote, never the USD number');
    assert.equal(init.json.fields.pp_TxnCurrency, 'PKR');
    assert.equal(init.json.display.amount, 'PKR 13,997.20');

    const form = (params) => new URLSearchParams(params).toString();
    const post = (params) => call('POST', '/api/payments/jazzcash/callback', { raw: form(params), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    const signed = (over = {}) => {
        const p = { pp_BillReference: id, pp_TxnRefNo: txn, pp_Amount: '1399720', pp_TxnCurrency: 'PKR', pp_ResponseCode: '000', ...over };
        return { ...p, pp_SecureHash: generateSecureHash(p, process.env.JAZZCASH_INTEGRITY_SALT) };
    };

    const forged = await post({ pp_BillReference: id, pp_ResponseCode: '000', pp_SecureHash: 'deadbeef' });
    assert.equal(forged.status, 302);
    assert.match(forged.headers.get('location'), /status=failed/);
    assert.equal(state.orders[0].status, 'pending');

    await post(signed({ pp_Amount: '100' }));
    assert.equal(state.orders[0].status, 'pending', 'underpayment must not pay the order');

    const ok = await post(signed());
    assert.match(ok.headers.get('location'), /status=success/);
    assert.equal(state.orders[0].status, 'paid');
    await post(signed()); // gateway retry
    assert.equal(state.calls.emails.filter((e) => e[0] === 'paid').length, 1);
});

test('Easypaisa callback: an unsigned "SUCCESS" post no longer pays the order', async () => {
    seed();
    const o = await placeOrder({ paymentMethod: 'easypaisa' });
    const id = o.json.order._id;
    process.env.EASYPAISA_STORE_ID = 'S1';
    await call('POST', '/api/payments/easypaisa/initiate', { body: { orderId: id }, headers: { 'x-order-token': o.json.accessToken } });

    const post = (params) => call('POST', '/api/payments/easypaisa/callback', { raw: new URLSearchParams(params).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });

    const attack = await post({ orderRefNum: id, status: 'SUCCESS' }); // exactly what worked before
    assert.match(attack.headers.get('location'), /status=pending/);
    assert.equal(state.orders[0].status, 'pending');

    const p = { orderRefNum: id, amount: '13997.20', status: 'SUCCESS', transactionId: 'EP1' };
    const ok = await post({ ...p, merchantHashedResp: generateSecureHash(p, process.env.EASYPAISA_HASH_KEY) });
    assert.match(ok.headers.get('location'), /status=success/);
    assert.equal(state.orders[0].status, 'paid');
});

/* ================= cancel / status rules ================= */
test('cancelling twice at the same moment restocks exactly once (and gives the coupon back once)', async () => {
    seed();
    const o = await placeOrder({ user: USERS.owner, items: [{ productId: 'shirt', qty: 3 }], extra: { couponCode: 'SAVE10' } });
    const id = o.json.order._id;
    assert.equal(state.products[0].stock, 7);
    assert.equal(state.coupons[0].usedCount, 1);

    const results = await Promise.all([
        call('PATCH', `/api/orders/${id}/cancel`, { headers: auth(USERS.owner) }),
        call('PATCH', `/api/orders/${id}/cancel`, { headers: auth(USERS.owner) }),
        call('PATCH', `/api/orders/admin/${id}/status`, { body: { status: 'cancelled' }, headers: auth(USERS.admin) }),
    ]);
    assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.equal(state.products[0].stock, 10, 'stock restored exactly once');
    assert.equal(state.coupons[0].usedCount, 0, 'coupon redemption returned exactly once');
});

test('RACE: two cancels that both already saw "pending" - only the atomic winner restocks', async () => {
    seed();
    const o = await placeOrder({ user: USERS.owner, items: [{ productId: 'shirt', qty: 4 }], extra: { couponCode: 'SAVE10' } });
    assert.equal(state.products[0].stock, 6);
    const { restockAndCancelOrder } = require('../utils/orderCancellation');
    // both callers loaded the order while it was still "pending" (stale snapshots), then race to cancel it
    const staleA = await fakes.Order.findById(o.json.order._id);
    const staleB = await fakes.Order.findById(o.json.order._id);
    const [a, b, c] = await Promise.all([restockAndCancelOrder(staleA, null), restockAndCancelOrder(staleB, null), restockAndCancelOrder(staleB, null)]);
    assert.equal([a, b, c].filter(Boolean).length, 1, 'exactly one caller may win');
    assert.equal(state.products[0].stock, 10, 'stock restored exactly once, not 2x or 3x');
    assert.equal(state.coupons[0].usedCount, 0);
});

test('a cancelled order can never be revived or re-cancelled', async () => {
    seed();
    const o = await placeOrder({ user: USERS.owner, items: [{ productId: 'shirt', qty: 2 }] });
    const id = o.json.order._id;
    await call('PATCH', `/api/orders/${id}/cancel`, { headers: auth(USERS.owner) });
    for (const status of ['pending', 'paid', 'shipped', 'delivered', 'cancelled']) {
        const r = await call('PATCH', `/api/orders/admin/${id}/status`, { body: { status }, headers: auth(USERS.admin) });
        assert.equal(r.status, 409, status);
    }
    assert.equal(state.orders[0].status, 'cancelled');
    assert.equal(state.products[0].stock, 10);
});

test('admin status changes follow the rules; non-admins are refused', async () => {
    seed();
    const o = await placeOrder({ paymentMethod: 'stripe' });
    const id = o.json.order._id;
    const admin = auth(USERS.admin);
    assert.equal((await call('PATCH', `/api/orders/admin/${id}/status`, { body: { status: 'paid' }, headers: auth(USERS.other) })).status, 403);
    assert.equal((await call('PATCH', `/api/orders/admin/${id}/status`, { body: { status: 'shipped' }, headers: admin })).status, 409); // unpaid online order
    assert.equal((await call('PATCH', `/api/orders/admin/${id}/status`, { body: { status: 'paid' }, headers: admin })).status, 200);
    assert.equal((await call('PATCH', `/api/orders/admin/${id}/status`, { body: { status: 'shipped' }, headers: admin })).status, 200);
    assert.equal((await call('PATCH', `/api/orders/admin/${id}/status`, { body: { status: 'cancelled' }, headers: admin })).status, 409); // already shipped
    assert.equal((await call('PATCH', `/api/orders/admin/${id}/status`, { body: { status: 'delivered' }, headers: admin })).status, 200);
    assert.equal((await call('PATCH', `/api/orders/admin/${id}/status`, { body: { status: { $ne: 1 } }, headers: admin })).status, 400);
});
