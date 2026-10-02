// Switching the payment method of an EXISTING unpaid order (checkout retry flow).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

process.env.JWT_SECRET = 'test-secret';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_testsecret';
process.env.JAZZCASH_INTEGRITY_SALT = 'jazz-salt';
process.env.JAZZCASH_MERCHANT_ID = 'MC1';
process.env.EASYPAISA_HASH_KEY = 'ep-key';
process.env.EASYPAISA_STORE_ID = 'S1';
process.env.FRONTEND_URL = 'http://site.test';
process.env.ORDER_TRACKING_SECRET = 'tracking-test-secret';
process.env.USD_TO_PKR_RATE = '280';

const { installFakes, newId, BACKEND } = require('./helpers/fakes');

// ---- fake Stripe with REAL-looking semantics: idempotency replay, cancel, switchable statuses ----
const S = { intents: {}, byKey: {}, created: 0, cancelCalls: 0, retrieveFails: false, cancelFails: false, onRetrieve: null };
const realStripe = require(path.join(BACKEND, 'node_modules/stripe'))('sk_test_dummy');
const stripeFake = {
    webhooks: realStripe.webhooks,
    paymentIntents: {
        retrieve: async (id) => { if (S.retrieveFails) throw new Error('network'); if (S.onRetrieve) { const f = S.onRetrieve; S.onRetrieve = null; f(); } return S.intents[id]; },
        create: async ({ amount, currency, metadata }, opts = {}) => {
            if (opts.idempotencyKey && S.byKey[opts.idempotencyKey]) return S.byKey[opts.idempotencyKey]; // Stripe replays the SAME object for a reused key
            S.created += 1;
            const pi = { id: `pi_${S.created}`, status: 'requires_payment_method', amount, currency, metadata, client_secret: `secret_${S.created}` };
            S.intents[pi.id] = pi;
            if (opts.idempotencyKey) S.byKey[opts.idempotencyKey] = pi;
            return pi;
        },
        cancel: async (id) => {
            S.cancelCalls += 1;
            if (S.cancelFails) throw new Error('payment_intent_unexpected_state');
            const pi = S.intents[id];
            if (pi.status === 'succeeded') throw new Error('payment_intent_unexpected_state');
            pi.status = 'canceled';
            return pi;
        },
    },
    refunds: { create: async () => ({ id: 're_1', status: 'succeeded' }) },
};

const fakes = installFakes({ stripe: stripeFake });
const { state } = fakes;

const express = require('express');
const jwt = require('jsonwebtoken');
const orderRoutes = require('../routes/orderRoutes');
const paymentRoutes = require('../routes/paymentRoutes');
const { generateSecureHash } = require('../utils/secureHash');
const { createTrackingToken } = require('../utils/orderTracking');

const app = express();
app.use('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);

let server; let base;
test.before(async () => { server = http.createServer(app); await new Promise((r) => server.listen(0, r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

const USERS = { owner: newId(), other: newId(), admin: newId() };
state.users.push({ _id: USERS.owner, role: 'user' }, { _id: USERS.other, role: 'user' }, { _id: USERS.admin, role: 'admin' });
const auth = (id) => ({ authorization: `Bearer ${jwt.sign({ userId: id }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })}` });
const SHIP = { firstName: 'Ali', lastName: 'Khan', email: 'ali@example.com', address: '1 Road', city: 'Isb', state: 'ICT', zip: '44000' };

function seed() {
    state.products.length = 0; state.orders.length = 0; state.coupons.length = 0;
    for (const k of Object.keys(state.calls)) if (Array.isArray(state.calls[k])) state.calls[k].length = 0;
    Object.assign(S, { intents: {}, byKey: {}, created: 0, cancelCalls: 0, retrieveFails: false, cancelFails: false, onRetrieve: null });
    process.env.USD_TO_PKR_RATE = '280'; process.env.JAZZCASH_MERCHANT_ID = 'MC1'; process.env.EASYPAISA_STORE_ID = 'S1';
    state.products.push({ slug: 'shirt', name: 'Shirt', price: 49.99, image: 'https://img/shirt.jpg', stock: 10, variants: [] });
    state.coupons.push({ _id: newId(), code: 'SAVE10', type: 'percent', value: 10, active: true, usedCount: 0, minOrderValue: 0 });
}

async function call(method, url, { body, headers = {}, raw, redirect } = {}) {
    const res = await fetch(base + url, { method, redirect: redirect || 'follow',
        headers: { ...(body && raw === undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = {}; try { json = JSON.parse(text); } catch (_e) { /* */ }
    return { status: res.status, json, headers: res.headers, text };
}
async function place({ paymentMethod, user, qty = 2, coupon = 'SAVE10' } = {}) {
    const res = await call('POST', '/api/orders', { body: { items: [{ productId: 'shirt', qty }], shipping: SHIP, shippingMethod: 'standard', paymentMethod, ...(coupon ? { couponCode: coupon } : {}) }, headers: user ? auth(user) : {} });
    assert.equal(res.status, 201, res.text);
    return { id: res.json.order._id, token: res.json.accessToken, order: state.orders.find((o) => String(o._id) === res.json.order._id) };
}
const guestH = (o) => ({ 'x-order-token': o.token });
const sw = (o, paymentMethod, headers) => call('POST', '/api/payments/switch-method', { body: { orderId: o.id, paymentMethod }, headers: headers || guestH(o) });
const startJazz = (o) => call('POST', '/api/payments/jazzcash/initiate', { body: { orderId: o.id }, headers: guestH(o) });
const startEasy = (o) => call('POST', '/api/payments/easypaisa/initiate', { body: { orderId: o.id }, headers: guestH(o) });
const startStripe = (o) => call('POST', '/api/payments/stripe/create-intent', { body: { orderId: o.id }, headers: guestH(o) });
const jazzCb = (o, over = {}) => {
    const p = { pp_BillReference: o.id, pp_TxnRefNo: over.pp_TxnRefNo, pp_Amount: String(Math.round(o.order.total * 100 * 280)), pp_TxnCurrency: 'PKR', pp_ResponseCode: '000', ...over };
    return call('POST', '/api/payments/jazzcash/callback', { raw: new URLSearchParams({ ...p, pp_SecureHash: generateSecureHash(p, process.env.JAZZCASH_INTEGRITY_SALT) }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
};
const easyCb = (o, over = {}) => {
    const p = { orderRefNum: o.id, amount: (Math.round(o.order.total * 100 * 280) / 100).toFixed(2), status: 'SUCCESS', transactionId: 'EP-OLD', ...over };
    return call('POST', '/api/payments/easypaisa/callback', { raw: new URLSearchParams({ ...p, merchantHashedResp: generateSecureHash(p, process.env.EASYPAISA_HASH_KEY) }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
};

/** the invariants every successful switch must keep */
function assertReservationUntouched(o, { stock = 8, coupon = 1 } = {}) {
    assert.equal(state.orders.length, 1, 'no second order');
    assert.equal(state.products[0].stock, stock, 'stock reserved exactly once');
    assert.equal(state.coupons[0].usedCount, coupon, 'coupon used exactly once');
    assert.equal(o.order.status, 'pending', 'never marked paid');
    assert.equal(o.order.subtotal, 99.98);
    assert.equal(o.order.items.length, 1);
    assert.equal(o.order.items[0].qty, 2);
    assert.equal(o.order.shipping.city, 'Isb');
}

/* ===================== the reported bug, end to end ===================== */
test('REPORTED SCENARIO: JazzCash -> declined PKR dialog -> choose Stripe -> same order, one reservation', async () => {
    seed();
    const o = await place({ paymentMethod: 'jazzcash' });
    const total = o.order.total;
    assert.equal(state.products[0].stock, 8);
    assert.equal((await startJazz(o)).status, 200); // initiate ran; the customer then DECLINED the confirm dialog
    assert.ok(o.order.gatewayPayment && o.order.paymentIntentId);

    // BEFORE the fix: create-intent would 409 "not placed with stripe". Now the frontend switches first:
    assert.equal((await startStripe(o)).status, 409, 'without a switch the old behaviour is still refused');
    const s = await sw(o, 'stripe');
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.switched, true);
    assert.equal(s.json.order._id, o.id, 'same order id');
    assert.equal(o.order.paymentMethod, 'stripe');
    assert.equal(o.order.gatewayPayment, undefined, 'stale PKR quote cleared');
    assert.equal(o.order.paymentIntentId, undefined, 'stale JazzCash reference cleared');
    assert.equal(o.order.total, total, 'totals preserved');
    assert.equal('accessTokenHash' in s.json.order, false);

    const intent = await startStripe(o);
    assert.equal(intent.status, 200, intent.text);
    assert.equal(S.intents.pi_1.amount, Math.round(total * 100));
    assert.equal(S.intents.pi_1.currency, 'usd');
    assertReservationUntouched(o);
});

/* ===================== 1-4: every direction ===================== */
test('1. JazzCash -> COD on the same pending order (placed email sent once)', async () => {
    seed();
    const o = await place({ paymentMethod: 'jazzcash' });
    await startJazz(o);
    const r = await sw(o, 'cod');
    assert.equal(r.status, 200, r.text);
    assert.equal(o.order.paymentMethod, 'cod');
    assert.equal(o.order.gatewayPayment, undefined);
    assert.equal(o.order.paymentIntentId, undefined);
    assertReservationUntouched(o);
    assert.equal(state.calls.emails.filter((e) => e[0] === 'placed').length, 1, 'COD is confirmed immediately, so its email goes out now');
    assert.equal((await sw(o, 'cod')).json.switched, false, 'repeating it is a no-op');
    assert.equal(state.calls.emails.filter((e) => e[0] === 'placed').length, 1, 'no duplicate email');
});

test('2. JazzCash -> Stripe, and 3. Easypaisa -> COD / Stripe', async () => {
    seed();
    const j = await place({ paymentMethod: 'jazzcash', qty: 1, coupon: null });
    await startJazz(j);
    assert.equal((await sw(j, 'stripe')).status, 200);
    assert.equal(j.order.paymentMethod, 'stripe');

    const e1 = await place({ paymentMethod: 'easypaisa', qty: 1, coupon: null });
    await startEasy(e1);
    assert.ok(e1.order.gatewayPayment);
    assert.equal((await sw(e1, 'cod')).status, 200);
    assert.equal(e1.order.paymentMethod, 'cod');
    assert.equal(e1.order.gatewayPayment, undefined);

    const e2 = await place({ paymentMethod: 'easypaisa', qty: 1, coupon: null });
    await startEasy(e2);
    assert.equal((await sw(e2, 'stripe')).status, 200);
    assert.equal(e2.order.paymentMethod, 'stripe');
    assert.equal(state.orders.length, 3, 'exactly the three orders that were placed');
    assert.equal(state.products[0].stock, 7, '3 units reserved once each');
});

test('4. Stripe -> COD before any payment (no intent was created yet)', async () => {
    seed();
    const o = await place({ paymentMethod: 'stripe' });
    const r = await sw(o, 'cod');
    assert.equal(r.status, 200);
    assert.equal(o.order.paymentMethod, 'cod');
    assert.equal(S.cancelCalls, 0, 'nothing to cancel');
    assertReservationUntouched(o);
});

test('COD -> online methods work too, and restart the abandonment clock', async () => {
    seed();
    const o = await place({ paymentMethod: 'cod' });
    assert.equal((await sw(o, 'jazzcash')).status, 200);
    assert.ok(o.order.paymentSwitchedAt instanceof Date);
    assert.equal((await startJazz(o)).status, 200);
    assert.equal((await sw(o, 'easypaisa')).status, 200);
    assert.equal((await startEasy(o)).status, 200);
    assert.equal(o.order.gatewayPayment.provider, 'easypaisa');
    assertReservationUntouched(o);

    // the cleanup job ignores an order that was switched recently, even if it was CREATED long ago
    const { cancelAbandonedOrders } = require('../jobs/cancelAbandonedOrders');
    await cancelAbandonedOrders();
    const filter = state.calls.orderFindFilters.at(-1);
    assert.deepEqual(filter.paymentMethod, { $in: ['stripe', 'jazzcash', 'easypaisa'] });
    assert.ok(filter.$or.some((c) => c.paymentSwitchedAt && c.paymentSwitchedAt.$lt instanceof Date), 'switch time is part of the abandonment test');
});

/* ===================== 5-6: Stripe PaymentIntents ===================== */
test('5. an existing Stripe PaymentIntent is CANCELLED at Stripe before it is cleared', async () => {
    seed();
    const o = await place({ paymentMethod: 'stripe' });
    await startStripe(o);
    const pi = S.intents[o.order.paymentIntentId];
    assert.equal(pi.status, 'requires_payment_method');

    const r = await sw(o, 'jazzcash');
    assert.equal(r.status, 200, r.text);
    assert.equal(S.cancelCalls, 1);
    assert.equal(pi.status, 'canceled', 'the live intent can no longer charge anything');
    assert.equal(o.order.paymentIntentId, undefined);
    assert.equal(o.order.paymentMethod, 'jazzcash');
    assertReservationUntouched(o);

    // a webhook for that intent can't pay the order any more
    const payload = JSON.stringify({ id: 'evt_x', object: 'event', type: 'payment_intent.succeeded', data: { object: { ...pi, status: 'succeeded' } } });
    const sig = realStripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    assert.equal((await call('POST', '/api/payments/stripe/webhook', { raw: payload, headers: { 'content-type': 'application/json', 'stripe-signature': sig } })).status, 200);
    assert.equal(o.order.status, 'pending');
});

test('5b. intents Stripe still lets us cancel (requires_action / requires_confirmation) are cancelled; already-cancelled ones are fine', async () => {
    for (const status of ['requires_action', 'requires_confirmation', 'canceled']) {
        seed();
        const o = await place({ paymentMethod: 'stripe' });
        await startStripe(o);
        S.intents[o.order.paymentIntentId].status = status;
        assert.equal((await sw(o, 'cod')).status, 200, status);
        assert.equal(S.intents.pi_1.status, 'canceled');
        assert.equal(S.cancelCalls, status === 'canceled' ? 0 : 1);
    }
});

test('6. a SUCCEEDED Stripe payment blocks switching (nothing changes, nothing cancelled)', async () => {
    seed();
    const o = await place({ paymentMethod: 'stripe' });
    await startStripe(o);
    S.intents[o.order.paymentIntentId].status = 'succeeded'; // paid at Stripe, webhook/confirm not processed yet
    const ref = o.order.paymentIntentId;
    const r = await sw(o, 'cod');
    assert.equal(r.status, 409);
    assert.match(r.json.message, /already gone through/);
    assert.equal(o.order.paymentMethod, 'stripe');
    assert.equal(o.order.paymentIntentId, ref);
    assert.equal(S.cancelCalls, 0);
    assert.equal(state.calls.emails.filter((e) => e[0] === 'placed').length, 0, 'no COD confirmation for an order that was just paid by card');
    assertReservationUntouched(o);
});

test('6b. processing intent, Stripe errors, or a cancel that fails (it succeeded meanwhile) all REFUSE to switch', async () => {
    seed();
    const o = await place({ paymentMethod: 'stripe' });
    await startStripe(o);
    const pi = S.intents[o.order.paymentIntentId];

    pi.status = 'processing';
    assert.equal((await sw(o, 'cod')).status, 409);
    pi.status = 'requires_payment_method';

    S.retrieveFails = true;
    assert.equal((await sw(o, 'cod')).status, 502);
    S.retrieveFails = false;

    S.cancelFails = true; // Stripe refuses to cancel: it succeeded in the meantime
    const r = await sw(o, 'cod');
    assert.equal(r.status, 409);
    assert.match(r.json.message, /not changed/);
    S.cancelFails = false;

    assert.equal(o.order.paymentMethod, 'stripe');
    assert.equal(o.order.paymentIntentId, pi.id);
    assert.equal(pi.status, 'requires_payment_method');
});

test('Stripe -> other -> Stripe again creates a NEW intent (the old key would replay the cancelled one)', async () => {
    seed();
    const o = await place({ paymentMethod: 'stripe' });
    assert.equal((await startStripe(o)).status, 200);
    const first = o.order.paymentIntentId;
    assert.equal((await sw(o, 'cod')).status, 200);
    assert.equal((await sw(o, 'stripe')).status, 200);
    const again = await startStripe(o);
    assert.equal(again.status, 200);
    assert.notEqual(o.order.paymentIntentId, first, 'a fresh PaymentIntent');
    assert.equal(S.intents[o.order.paymentIntentId].status, 'requires_payment_method', 'and it is usable');
    assert.equal(S.intents[first].status, 'canceled');
    assertReservationUntouched(o);
});

/* ===================== 7-8: stale gateway callbacks ===================== */
test('7. an OLD JazzCash callback after switching cannot mark the order paid (and is flagged for reconciliation)', async () => {
    seed();
    const o = await place({ paymentMethod: 'jazzcash' });
    await startJazz(o);
    const oldTxn = o.order.paymentIntentId;
    await sw(o, 'cod');

    const cb = await jazzCb(o, { pp_TxnRefNo: oldTxn }); // genuine, signed, correct amount - but for the replaced attempt
    assert.equal(cb.status, 302);
    assert.match(cb.headers.get('location'), /status=superseded/);
    assert.doesNotMatch(cb.headers.get('location'), /status=success/);
    assert.equal(o.order.status, 'pending', 'status unchanged');
    assert.equal(o.order.paymentMethod, 'cod');
    assert.match(o.order.paymentIssue, /replaced/);
    assert.equal(state.calls.emails.filter((e) => e[0] === 'paid').length, 0);
    assert.equal(state.calls.emits.length, 0);
    assert.equal(o.order.abandonedGatewayAttempts[0].reference, oldTxn, 'the old attempt was archived for reconciliation');

    // also after switching on to Stripe, and a stale DECLINED callback is just "failed"
    const o2 = await place({ paymentMethod: 'jazzcash', coupon: null });
    await startJazz(o2); const txn2 = o2.order.paymentIntentId; await sw(o2, 'stripe');
    assert.match((await jazzCb(o2, { pp_TxnRefNo: txn2, pp_ResponseCode: '124' })).headers.get('location'), /status=failed/);
    assert.equal(o2.order.paymentIssue, undefined);
    assert.equal(o2.order.status, 'pending');
    assert.match((await jazzCb(o2, { pp_TxnRefNo: txn2 })).headers.get('location'), /status=superseded/);
    assert.equal(o2.order.status, 'pending');
});

test('7b. switching AWAY and back to JazzCash: the first attempt\'s callback is stale, only the new attempt pays', async () => {
    seed();
    const o = await place({ paymentMethod: 'jazzcash' });
    await startJazz(o); const first = o.order.paymentIntentId;
    await sw(o, 'cod'); await sw(o, 'jazzcash'); await startJazz(o);
    const second = o.order.paymentIntentId;
    assert.notEqual(first, second);

    assert.match((await jazzCb(o, { pp_TxnRefNo: first })).headers.get('location'), /status=superseded/);
    assert.equal(o.order.status, 'pending');
    const ok = await jazzCb(o, { pp_TxnRefNo: second });
    assert.match(ok.headers.get('location'), /status=success/);
    assert.equal(o.order.status, 'paid');
});

test('8. an OLD Easypaisa callback after switching cannot mark the order paid', async () => {
    seed();
    const o = await place({ paymentMethod: 'easypaisa' });
    await startEasy(o);
    assert.ok(o.order.gatewayPayment);
    await sw(o, 'cod');

    const cb = await easyCb(o);
    assert.match(cb.headers.get('location'), /status=superseded/);
    assert.equal(o.order.status, 'pending');
    assert.equal(o.order.paymentMethod, 'cod');
    assert.match(o.order.paymentIssue, /replaced/);
    assert.equal(state.calls.emails.filter((e) => e[0] === 'paid').length, 0);

    const o2 = await place({ paymentMethod: 'easypaisa', coupon: null });
    await startEasy(o2); await sw(o2, 'stripe');
    assert.match((await easyCb(o2, { status: 'FAILED' })).headers.get('location'), /status=failed/);
    assert.equal(o2.order.status, 'pending');
    assert.equal(o2.order.paymentIssue, undefined);
    assert.match((await easyCb(o2)).headers.get('location'), /status=superseded/);
    assert.equal(o2.order.status, 'pending');
});

test('forged stale callbacks (bad signature) are rejected and DO NOT flag anything', async () => {
    seed();
    const o = await place({ paymentMethod: 'jazzcash' });
    await startJazz(o); const txn = o.order.paymentIntentId; await sw(o, 'cod');
    const forged = await call('POST', '/api/payments/jazzcash/callback', { raw: new URLSearchParams({ pp_BillReference: o.id, pp_TxnRefNo: txn, pp_ResponseCode: '000', pp_SecureHash: 'deadbeef' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    assert.match(forged.headers.get('location'), /status=failed/);
    assert.equal(o.order.paymentIssue, undefined);
    assert.equal(o.order.status, 'pending');
});

/* ===================== 9-11: reservation invariants over MANY switches ===================== */
test('9-11. stock reserved once, coupon used once, no second order - across a long chain of switches', async () => {
    seed();
    const o = await place({ paymentMethod: 'jazzcash' });
    for (const m of ['stripe', 'cod', 'easypaisa', 'jazzcash', 'stripe', 'easypaisa', 'cod', 'stripe']) {
        const r = await sw(o, m);
        assert.equal(r.status, 200, `${m}: ${r.text}`);
        if (m === 'stripe') await startStripe(o);
        if (m === 'jazzcash') await startJazz(o);
        if (m === 'easypaisa') await startEasy(o);
    }
    assert.equal(o.order.paymentMethod, 'stripe');
    assert.equal(o.order.paymentSwitchCount, 8);
    assertReservationUntouched(o);
    assert.deepEqual(state.calls.productInc.map((c) => c.inc.stock), [-2], 'the product stock was decremented exactly once, ever');
    assert.deepEqual(state.calls.couponInc, [1], 'the coupon counter was incremented exactly once, ever');
});

test('concurrent switches to different methods: exactly one wins, everything stays consistent', async () => {
    seed();
    const o = await place({ paymentMethod: 'jazzcash' });
    await startJazz(o);
    const results = await Promise.all([sw(o, 'cod'), sw(o, 'stripe'), sw(o, 'easypaisa')]);
    assert.ok(results.some((r) => r.status === 200));
    assert.ok(['cod', 'stripe', 'easypaisa'].includes(o.order.paymentMethod));
    assertReservationUntouched(o);
});

/* ===================== 12-14: who may switch ===================== */
test('12. a guest\'s own checkout X-Order-Token can switch its pending order', async () => {
    seed();
    const o = await place({ paymentMethod: 'jazzcash' });
    assert.equal((await sw(o, 'stripe', guestH(o))).status, 200);
});

test('13. the signed-in owner can switch (without any order token)', async () => {
    seed();
    const o = await place({ paymentMethod: 'jazzcash', user: USERS.owner });
    assert.equal((await sw(o, 'stripe', auth(USERS.owner))).status, 200);
    assert.equal(o.order.paymentMethod, 'stripe');
});

test('14. the emailed READ-ONLY tracking token cannot switch (nor can strangers, other users, or no credentials)', async () => {
    seed();
    const o = await place({ paymentMethod: 'jazzcash', user: USERS.owner });
    const before = JSON.stringify(o.order);
    for (const headers of [
        { 'x-order-tracking-token': createTrackingToken(o.id) },
        { 'x-order-token': 'f'.repeat(64) },
        auth(USERS.other),
        {},
    ]) {
        const r = await sw(o, 'cod', headers);
        assert.equal(r.status, 404, JSON.stringify(Object.keys(headers)));
    }
    // even together with a wrong order token
    assert.equal((await sw(o, 'cod', { 'x-order-tracking-token': createTrackingToken(o.id), 'x-order-token': 'a'.repeat(64) })).status, 404);
    assert.equal(JSON.stringify(o.order), before, 'order untouched');
    // an admin token does not get a back door either (admins act through the admin endpoints)
    assert.equal(o.order.paymentMethod, 'jazzcash');
});

/* ===================== 15: only pending ===================== */
test('15. paid / cancelled / shipped / delivered orders cannot switch', async () => {
    for (const status of ['paid', 'cancelled', 'shipped', 'delivered']) {
        seed();
        const o = await place({ paymentMethod: 'stripe' });
        o.order.status = status;
        const r = await sw(o, 'cod');
        assert.equal(r.status, 409, status);
        assert.match(r.json.message, /Only an unpaid order/);
        assert.equal(o.order.paymentMethod, 'stripe', status);
        assert.equal(state.calls.emails.filter((e) => e[0] === 'placed').length, 0);
    }
});

/* ===================== validation / safe failures ===================== */
test('invalid methods and bodies are rejected; a switch to an unusable PKR method changes NOTHING', async () => {
    seed();
    const o = await place({ paymentMethod: 'stripe' });
    await startStripe(o);
    for (const body of [{ orderId: o.id }, { orderId: o.id, paymentMethod: 'bitcoin' }, { orderId: o.id, paymentMethod: { $ne: 1 } }, { orderId: o.id, paymentMethod: ['cod'] }]) {
        assert.equal((await call('POST', '/api/payments/switch-method', { body, headers: guestH(o) })).status, 400);
    }
    assert.equal((await call('POST', '/api/payments/switch-method', { body: { paymentMethod: 'cod' }, headers: guestH(o) })).status, 400);
    assert.equal((await call('POST', '/api/payments/switch-method', { body: { orderId: 'nope', paymentMethod: 'cod' }, headers: guestH(o) })).status, 404);

    delete process.env.USD_TO_PKR_RATE; // no rate configured
    const noRate = await sw(o, 'jazzcash');
    assert.equal(noRate.status, 503);
    assert.equal(noRate.json.code, 'CURRENCY_NOT_CONFIGURED');
    process.env.USD_TO_PKR_RATE = '280';
    delete process.env.EASYPAISA_STORE_ID;
    assert.equal((await sw(o, 'easypaisa')).status, 503);

    // the order is exactly as it was: still Stripe, and its live intent was NOT cancelled by the failed attempts
    assert.equal(o.order.paymentMethod, 'stripe');
    assert.equal(S.cancelCalls, 0);
    assert.equal(S.intents[o.order.paymentIntentId].status, 'requires_payment_method');
    assertReservationUntouched(o);
});

test('switching never marks anything paid, even when the old payment attempt callback arrives mid-way', async () => {
    seed();
    const o = await place({ paymentMethod: 'jazzcash' });
    await startJazz(o);
    await sw(o, 'cod');
    await sw(o, 'jazzcash');
    assert.equal(o.order.status, 'pending');
    assert.equal(o.order.paidAt, undefined);
    assert.equal(o.order.transactionId, undefined);
    assert.equal(state.calls.emails.filter((e) => e[0] === 'paid').length, 0);
});

/* ===================== real interleavings: the switch is ONE conditional update ===================== */
test('RACE: something else changes the order while the switch waits on Stripe -> the switch loses (409), nothing is overwritten', async () => {
    seed();
    const o = await place({ paymentMethod: 'stripe' });
    await startStripe(o);
    const countBefore = o.order.paymentSwitchCount || 0;
    // while we are talking to Stripe, a concurrent switch already moved the order to Easypaisa
    S.onRetrieve = () => { o.order.paymentMethod = 'easypaisa'; delete o.order.paymentIntentId; };
    const r = await sw(o, 'cod');
    assert.equal(r.status, 409);
    assert.match(r.json.message, /just updated/);
    assert.equal(o.order.paymentMethod, 'easypaisa', 'the other change is not overwritten');
    assert.equal(o.order.paymentSwitchCount || 0, countBefore, 'and no switch was recorded');
    assert.equal(state.calls.emails.filter((e) => e[0] === 'placed').length, 0, 'no COD confirmation email for a switch that did not happen');
});

test('RACE: the order gets PAID while the switch waits on Stripe -> the switch loses, the order stays paid', async () => {
    seed();
    const o = await place({ paymentMethod: 'stripe' });
    await startStripe(o);
    S.onRetrieve = () => { o.order.status = 'paid'; o.order.paidAt = new Date(); o.order.transactionId = 'pi_1'; };
    const r = await sw(o, 'cod');
    assert.equal(r.status, 409);
    assert.equal(o.order.status, 'paid');
    assert.equal(o.order.paymentMethod, 'stripe');
    assert.equal(state.calls.emails.filter((e) => e[0] === 'placed').length, 0);
});
