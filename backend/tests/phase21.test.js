// Phase 2.1 - route-level tests: guest tracking tokens, currency, refunds/cancellation, late payments.
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

// ---- fake Stripe: refunds with idempotency keys, switchable failures ----
const stripeState = { intents: {}, refundsByKey: {}, refundCalls: 0, distinctRefunds: 0, nextRefund: 'succeeded', failNext: false, intentCount: 0 };
const realStripe = require(path.join(BACKEND, 'node_modules/stripe'))('sk_test_dummy');
const stripeFake = {
    webhooks: realStripe.webhooks,
    paymentIntents: {
        retrieve: async (id) => stripeState.intents[id],
        create: async ({ amount, currency, metadata }) => {
            stripeState.intentCount += 1;
            const pi = { id: `pi_${stripeState.intentCount}`, status: 'requires_payment_method', amount, currency, metadata, client_secret: `secret_${stripeState.intentCount}` };
            stripeState.intents[pi.id] = pi;
            return pi;
        },
    },
    refunds: {
        create: async (params, opts = {}) => {
            stripeState.refundCalls += 1;
            if (stripeState.failNext) { stripeState.failNext = false; throw new Error('stripe is down'); }
            const key = opts.idempotencyKey;
            if (key && stripeState.refundsByKey[key]) return stripeState.refundsByKey[key]; // idempotent replay
            stripeState.distinctRefunds += 1;
            const refund = { id: `re_${stripeState.distinctRefunds}`, status: stripeState.nextRefund, payment_intent: params.payment_intent };
            if (key) stripeState.refundsByKey[key] = refund;
            return refund;
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
const { createTrackingToken } = require('../utils/orderTracking');

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
const auth = (userId) => ({ authorization: `Bearer ${jwtFor(userId)}` });
const SHIP = { firstName: 'Ali', lastName: 'Khan', email: 'ali@example.com', address: '1 Road', city: 'Isb', state: 'ICT', zip: '44000' };

function seed() {
    state.products.length = 0; state.orders.length = 0; state.coupons.length = 0;
    state.calls.emails.length = 0; state.calls.emits.length = 0; state.calls.productInc.length = 0; state.calls.couponInc.length = 0;
    Object.assign(stripeState, { intents: {}, refundsByKey: {}, refundCalls: 0, distinctRefunds: 0, nextRefund: 'succeeded', failNext: false, intentCount: 0 });
    process.env.USD_TO_PKR_RATE = '280';
    state.products.push({ slug: 'shirt', name: 'Shirt', price: 49.99, image: 'https://img/shirt.jpg', stock: 10, variants: [] });
    state.coupons.push({ _id: newId(), code: 'SAVE10', type: 'percent', value: 10, active: true, usedCount: 0, minOrderValue: 0 });
}

async function call(method, url, { body, headers = {}, raw, redirect } = {}) {
    const res = await fetch(base + url, {
        method, redirect: redirect || 'follow',
        headers: { ...(body && raw === undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: raw !== undefined ? raw : body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch (_e) { /* redirects */ }
    return { status: res.status, json, headers: res.headers, text };
}

async function place({ paymentMethod = 'stripe', user, qty = 1, coupon } = {}) {
    const res = await call('POST', '/api/orders', {
        body: { items: [{ productId: 'shirt', qty }], shipping: SHIP, shippingMethod: 'standard', paymentMethod, ...(coupon ? { couponCode: coupon } : {}) },
        headers: user ? auth(user) : {},
    });
    assert.equal(res.status, 201, res.text);
    return { id: res.json.order._id, token: res.json.accessToken, order: res.json.order };
}

/** Takes a real Stripe payment through create-intent + confirm so the order is genuinely "paid". */
async function payWithStripe(o) {
    const headers = { 'x-order-token': o.token };
    await call('POST', '/api/payments/stripe/create-intent', { body: { orderId: o.id }, headers });
    const order = state.orders.find((x) => String(x._id) === o.id);
    const pi = stripeState.intents[order.paymentIntentId];
    pi.status = 'succeeded';
    const r = await call('POST', `/api/payments/stripe/confirm/${o.id}`, { body: {}, headers });
    assert.equal(r.status, 200, r.text);
    assert.equal(order.status, 'paid');
    return order;
}

const jazzForm = (id, txn, over = {}) => {
    const p = { pp_BillReference: id, pp_TxnRefNo: txn, pp_Amount: '1399720', pp_TxnCurrency: 'PKR', pp_ResponseCode: '000', ...over };
    return new URLSearchParams({ ...p, pp_SecureHash: generateSecureHash(p, process.env.JAZZCASH_INTEGRITY_SALT) }).toString();
};
const postJazz = (raw) => call('POST', '/api/payments/jazzcash/callback', { raw, headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });

/* ============================ 1. guest email tracking ============================ */
test('tracking: a valid emailed token opens the order from ANY browser (no cookies, no X-Order-Token)', async () => {
    seed();
    const o = await place();
    const trackingToken = createTrackingToken(o.id);
    const res = await call('GET', `/api/orders/${o.id}`, { headers: { 'x-order-tracking-token': trackingToken } });
    assert.equal(res.status, 200);
    assert.equal(res.json.order.shipping.city, 'Isb');
    assert.equal('accessTokenHash' in res.json.order, false);
});

test('tracking: missing, forged, edited, expired and other-order tokens all get a plain 404', async () => {
    seed();
    const a = await place();
    const b = await place();
    const good = createTrackingToken(a.id);
    const [id, exp, sig] = good.split('.');
    const attempts = {
        none: undefined,
        garbage: 'nope',
        forgedSignature: `${id}.${exp}.${sig.slice(0, -3)}abc`,
        extendedExpiry: `${id}.${Number(exp) + 10 ** 6}.${sig}`,
        expired: createTrackingToken(a.id, Date.now() - 200 * 24 * 3600 * 1000),
        tokenForOtherOrder: createTrackingToken(b.id), // valid token, but for order B
        repointedToB: good.replace(a.id, b.id),
    };
    for (const [name, token] of Object.entries(attempts)) {
        const res = await call('GET', `/api/orders/${a.id}`, { headers: token ? { 'x-order-tracking-token': token } : {} });
        assert.equal(res.status, 404, name);
        assert.equal(JSON.stringify(res.json).includes('Isb'), false, `${name} must leak nothing`);
    }
    // the same token is fine for ITS order
    assert.equal((await call('GET', `/api/orders/${b.id}`, { headers: { 'x-order-tracking-token': attempts.tokenForOtherOrder } })).status, 200);
});

test('tracking: a token signed with a different secret is rejected', async () => {
    seed();
    const o = await place();
    process.env.ORDER_TRACKING_SECRET = 'someone-elses-secret';
    const forged = createTrackingToken(o.id);
    process.env.ORDER_TRACKING_SECRET = 'tracking-test-secret';
    assert.equal((await call('GET', `/api/orders/${o.id}`, { headers: { 'x-order-tracking-token': forged } })).status, 404);
});

test('tracking: the existing access methods all still work, and the order id ALONE reveals nothing', async () => {
    seed();
    const guest = await place();
    const mine = await place({ user: USERS.owner });

    // order id alone (and every partial credential) -> nothing
    for (const headers of [{}, { 'x-order-token': 'f'.repeat(64) }, { 'x-order-tracking-token': 'x' }, auth(USERS.other)]) {
        const r = await call('GET', `/api/orders/${guest.id}`, { headers });
        assert.equal(r.status, 404);
        assert.equal(r.text.includes('ali@example.com'), false);
    }
    assert.equal((await call('GET', `/api/orders/${guest.id}`, { headers: { 'x-order-token': guest.token } })).status, 200, 'checkout X-Order-Token');
    assert.equal((await call('GET', `/api/orders/${mine.id}`, { headers: auth(USERS.owner) })).status, 200, 'signed-in owner');
    assert.equal((await call('GET', `/api/orders/${guest.id}`, { headers: auth(USERS.admin) })).status, 200, 'admin');
    // both mechanisms can be sent together
    assert.equal((await call('GET', `/api/orders/${guest.id}`, { headers: { 'x-order-token': guest.token, 'x-order-tracking-token': createTrackingToken(guest.id) } })).status, 200);
});

test('tracking: the emailed token is READ-ONLY - it cannot pay, start a payment, or cancel', async () => {
    seed();
    const o = await place({ user: USERS.owner });
    const t = { 'x-order-tracking-token': createTrackingToken(o.id) };
    for (const [m, u, body] of [
        ['POST', '/api/payments/stripe/create-intent', { orderId: o.id }],
        ['POST', `/api/payments/stripe/confirm/${o.id}`, {}],
        ['POST', '/api/payments/jazzcash/initiate', { orderId: o.id }],
        ['POST', '/api/payments/easypaisa/initiate', { orderId: o.id }],
    ]) {
        assert.equal((await call(m, u, { body, headers: t })).status, 404, u);
    }
    assert.equal((await call('PATCH', `/api/orders/${o.id}/cancel`, { headers: t })).status, 401); // needs a real login
    assert.equal(state.orders[0].status, 'pending');
});

test('tracking: the token is never written to the console/logs while it is used', async () => {
    seed();
    const o = await place();
    const token = createTrackingToken(o.id);
    const seen = [];
    const originals = {};
    for (const k of ['log', 'error', 'warn', 'info']) { originals[k] = console[k]; console[k] = (...a) => seen.push(a.map(String).join(' ')); }
    try {
        await call('GET', `/api/orders/${o.id}`, { headers: { 'x-order-tracking-token': token } });
        await call('GET', `/api/orders/${o.id}`, { headers: { 'x-order-tracking-token': token.slice(0, -2) + 'zz' } });
    } finally { Object.assign(console, originals); }
    assert.equal(seen.some((line) => line.includes(token) || line.includes(token.split('.')[2])), false);
});

/* ============================ 2. currency ============================ */
test('currency: orders record USD; Stripe intent is USD for the exact total', async () => {
    seed();
    const o = await place({ qty: 2 });
    assert.equal(o.order.currency, 'USD');
    await call('POST', '/api/payments/stripe/create-intent', { body: { orderId: o.id }, headers: { 'x-order-token': o.token } });
    assert.equal(stripeState.intents.pi_1.currency, 'usd');
    assert.equal(stripeState.intents.pi_1.amount, 9998);
});

test('currency: JazzCash/Easypaisa FAIL CLOSED without a configured PKR rate - nothing is charged or redirected', async () => {
    for (const bad of [undefined, '', 'abc', '0', '-280']) {
        seed();
        if (bad === undefined) delete process.env.USD_TO_PKR_RATE; else process.env.USD_TO_PKR_RATE = bad;
        for (const method of ['jazzcash', 'easypaisa']) {
            const o = await place({ paymentMethod: method });
            const r = await call('POST', `/api/payments/${method}/initiate`, { body: { orderId: o.id }, headers: { 'x-order-token': o.token } });
            assert.equal(r.status, 503, `${method} with rate ${JSON.stringify(bad)}`);
            assert.equal(r.json.code, 'CURRENCY_NOT_CONFIGURED');
            assert.match(r.json.message, /not configured for this currency/);
            assert.equal('fields' in r.json, false, 'no gateway form may be returned');
            const order = state.orders.find((x) => String(x._id) === o.id);
            assert.equal(order.gatewayPayment, undefined);
            assert.equal(order.paymentIntentId, undefined);
            assert.equal(order.status, 'pending');
        }
    }
});

test('currency: /payments/config only offers PKR methods when credentials AND a rate exist', async () => {
    seed();
    let cfg = (await call('GET', '/api/payments/config')).json;
    assert.equal(cfg.storeCurrency, 'USD');
    assert.equal(cfg.gateways.jazzcash.available, true);
    assert.equal(cfg.gateways.jazzcash.usdToPkrRate, 280);
    assert.equal(cfg.gateways.jazzcash.currency, 'PKR');
    delete process.env.USD_TO_PKR_RATE;
    cfg = (await call('GET', '/api/payments/config')).json;
    assert.equal(cfg.gateways.jazzcash.available, false);
    assert.equal(cfg.gateways.easypaisa.available, false);
    assert.equal(cfg.gateways.jazzcash.usdToPkrRate, null);
});

test('currency: the customer is shown the EXACT currency and amount, and the snapshot is frozen on the order', async () => {
    seed();
    const o = await place({ paymentMethod: 'jazzcash' });
    const r = await call('POST', '/api/payments/jazzcash/initiate', { body: { orderId: o.id }, headers: { 'x-order-token': o.token } });
    assert.equal(r.status, 200);
    assert.deepEqual(
        { currency: r.json.display.currency, amountMinor: r.json.display.amountMinor, amount: r.json.display.amount, orderTotal: r.json.display.orderTotal, rate: r.json.display.rate },
        { currency: 'PKR', amountMinor: 1399720, amount: 'PKR 13,997.20', orderTotal: 'USD 49.99', rate: 280 }
    );
    assert.equal(r.json.fields.pp_Amount, '1399720');
    assert.equal(r.json.fields.pp_TxnCurrency, 'PKR');
    const order = state.orders[0];
    assert.equal(order.gatewayPayment.amountMinor, 1399720);
    assert.equal(order.gatewayPayment.currency, 'PKR');
    assert.equal(order.gatewayPayment.rate, 280);

    // the rate later changes: the open payment is still judged against what the customer was shown
    process.env.USD_TO_PKR_RATE = '300';
    const txn = order.paymentIntentId;
    const ok = await postJazz(jazzForm(o.id, txn)); // 1399720 = the amount that was quoted
    assert.match(ok.headers.get('location'), /status=success/);
    assert.equal(order.status, 'paid');

    const ep = await place({ paymentMethod: 'easypaisa' });
    const e = await call('POST', '/api/payments/easypaisa/initiate', { body: { orderId: ep.id }, headers: { 'x-order-token': ep.token } });
    assert.equal(e.json.fields.amount, '14997.00'.replace('14997.00', (Math.round(4999 * 300) / 100).toFixed(2)));
    assert.equal(e.json.display.currency, 'PKR');
});

test('currency mismatch: a USD-sized amount or a USD currency code can never pay a PKR order', async () => {
    seed();
    const o = await place({ paymentMethod: 'jazzcash' });
    await call('POST', '/api/payments/jazzcash/initiate', { body: { orderId: o.id }, headers: { 'x-order-token': o.token } });
    const order = state.orders[0];
    const txn = order.paymentIntentId;

    // correctly SIGNED callbacks that would have "worked" if USD were reinterpreted as PKR
    for (const over of [{ pp_Amount: '4999' }, { pp_Amount: '4999', pp_TxnCurrency: 'USD' }, { pp_TxnCurrency: 'USD' }, { pp_Amount: '1399719' }, { pp_Amount: '13997' }]) {
        const r = await postJazz(jazzForm(o.id, txn, over));
        assert.match(r.headers.get('location'), /status=failed/, JSON.stringify(over));
        assert.equal(order.status, 'pending', JSON.stringify(over));
    }
    assert.equal(state.calls.emails.filter((e) => e[0] === 'paid').length, 0);
});

test('currency mismatch: Easypaisa and Stripe amounts/currencies are checked too', async () => {
    seed();
    const ep = await place({ paymentMethod: 'easypaisa' });
    await call('POST', '/api/payments/easypaisa/initiate', { body: { orderId: ep.id }, headers: { 'x-order-token': ep.token } });
    const postEp = (p) => call('POST', '/api/payments/easypaisa/callback', { raw: new URLSearchParams({ ...p, merchantHashedResp: generateSecureHash(p, process.env.EASYPAISA_HASH_KEY) }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    const usdAsPkr = await postEp({ orderRefNum: ep.id, amount: '49.99', status: 'SUCCESS', transactionId: 'EP1' });
    assert.match(usdAsPkr.headers.get('location'), /status=pending/);
    assert.equal(state.orders.find((x) => String(x._id) === ep.id).status, 'pending');

    // Stripe: an intent in another currency for the "right" number is refused
    const st = await place({ paymentMethod: 'stripe' });
    const headers = { 'x-order-token': st.token };
    await call('POST', '/api/payments/stripe/create-intent', { body: { orderId: st.id }, headers });
    const pi = stripeState.intents[state.orders.find((x) => String(x._id) === st.id).paymentIntentId];
    pi.status = 'succeeded'; pi.currency = 'pkr';
    assert.equal((await call('POST', `/api/payments/stripe/confirm/${st.id}`, { body: {}, headers })).status, 400);
    assert.equal(state.orders.find((x) => String(x._id) === st.id).status, 'pending');
});

/* ============================ 3. cancellation & refunds ============================ */
test('customer cancel: an UNPAID order is cancelled and restocked once; a PAID online order is refused', async () => {
    seed();
    const pending = await place({ user: USERS.owner, qty: 3 });
    assert.equal(state.products[0].stock, 7);
    assert.equal((await call('PATCH', `/api/orders/${pending.id}/cancel`, { headers: auth(USERS.owner) })).status, 200);
    assert.equal(state.products[0].stock, 10);
    assert.equal((await call('PATCH', `/api/orders/${pending.id}/cancel`, { headers: auth(USERS.owner) })).status, 400); // already cancelled

    const paid = await place({ user: USERS.owner, qty: 2 });
    const order = await payWithStripe(paid);
    const stockBefore = state.products[0].stock;
    const r = await call('PATCH', `/api/orders/${paid.id}/cancel`, { headers: auth(USERS.owner) });
    assert.equal(r.status, 400);
    assert.match(r.json.message, /contact support/i);
    assert.doesNotMatch(r.json.message, /will be refunded/i, 'must not promise a refund');
    assert.equal(order.status, 'paid');
    assert.equal(state.products[0].stock, stockBefore, 'no stock restored');
    assert.equal(stripeState.refundCalls, 0);
});

test('admin cannot just flip an ONLINE-paid order to cancelled; a manually-paid COD order still can', async () => {
    seed();
    const o = await place({ user: USERS.owner, qty: 2 });
    const order = await payWithStripe(o);
    const stock = state.products[0].stock;
    const r = await call('PATCH', `/api/orders/admin/${o.id}/status`, { body: { status: 'cancelled' }, headers: auth(USERS.admin) });
    assert.equal(r.status, 409);
    assert.match(r.json.message, /Refund/);
    assert.equal(order.status, 'paid');
    assert.equal(state.products[0].stock, stock);

    const cod = await place({ paymentMethod: 'cod', qty: 1 });
    await call('PATCH', `/api/orders/admin/${cod.id}/status`, { body: { status: 'paid' }, headers: auth(USERS.admin) });
    const before = state.products[0].stock;
    assert.equal((await call('PATCH', `/api/orders/admin/${cod.id}/status`, { body: { status: 'cancelled' }, headers: auth(USERS.admin) })).status, 200);
    assert.equal(state.products[0].stock, before + 1);
});

test('Stripe refund: refunds for real, THEN cancels, restocks once, returns the coupon, emails the truth', async () => {
    seed();
    const o = await place({ user: USERS.owner, qty: 3, coupon: 'SAVE10' });
    const order = await payWithStripe(o);
    assert.equal(state.products[0].stock, 7);
    assert.equal(state.coupons[0].usedCount, 1);

    const r = await call('POST', `/api/orders/admin/${o.id}/refund`, { body: {}, headers: auth(USERS.admin) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.refund.status, 'succeeded');
    assert.equal(r.json.refund.refundId, 're_1');
    assert.equal(order.status, 'cancelled');
    assert.equal(order.refundStatus, 'succeeded');
    assert.equal(state.products[0].stock, 10, 'restocked once');
    assert.equal(state.coupons[0].usedCount, 0, 'coupon returned once');
    assert.equal(stripeState.distinctRefunds, 1);
    const mail = state.calls.emails.filter((e) => e[0] === 'status');
    assert.equal(mail.length, 1);
    assert.deepEqual(mail[0].slice(2), ['cancelled', 'succeeded']);
    assert.ok(state.calls.emits.some((e) => e[1] === 'cancelled'));

    // repeating it changes nothing
    const again = await call('POST', `/api/orders/admin/${o.id}/refund`, { body: {}, headers: auth(USERS.admin) });
    assert.equal(again.status, 409);
    assert.equal(stripeState.distinctRefunds, 1);
    assert.equal(state.products[0].stock, 10);
});

test('Stripe refund: duplicate / concurrent refund+cancel attempts create ONE refund and restock ONCE', async () => {
    seed();
    const o = await place({ user: USERS.owner, qty: 4, coupon: 'SAVE10' });
    const order = await payWithStripe(o);
    const results = await Promise.all([
        call('POST', `/api/orders/admin/${o.id}/refund`, { body: {}, headers: auth(USERS.admin) }),
        call('POST', `/api/orders/admin/${o.id}/refund`, { body: {}, headers: auth(USERS.admin) }),
        call('POST', `/api/orders/admin/${o.id}/refund`, { body: {}, headers: auth(USERS.admin) }),
        call('PATCH', `/api/orders/admin/${o.id}/status`, { body: { status: 'cancelled' }, headers: auth(USERS.admin) }),
        call('PATCH', `/api/orders/${o.id}/cancel`, { headers: auth(USERS.owner) }),
    ]);
    assert.ok(results.some((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
    assert.equal(stripeState.distinctRefunds, 1, 'Stripe idempotency key: one real refund');
    assert.equal(order.status, 'cancelled');
    assert.equal(state.products[0].stock, 10, 'stock restored exactly once');
    assert.equal(state.coupons[0].usedCount, 0, 'coupon returned exactly once');
    assert.equal(state.calls.emails.filter((e) => e[0] === 'status').length, 1, 'one cancellation email');
});

test('Stripe refund failure: the order stays PAID, nothing is restocked, no cancellation email; a retry then works', async () => {
    seed();
    const o = await place({ user: USERS.owner, qty: 2 });
    const order = await payWithStripe(o);
    const stock = state.products[0].stock;

    stripeState.failNext = true; // Stripe throws
    let r = await call('POST', `/api/orders/admin/${o.id}/refund`, { body: {}, headers: auth(USERS.admin) });
    assert.equal(r.status, 502);
    assert.match(r.json.message, /NOT cancelled/);
    assert.equal(order.status, 'paid');
    assert.equal(order.refundStatus, 'failed');
    assert.equal(state.products[0].stock, stock);
    assert.equal(state.calls.emails.filter((e) => e[0] === 'status').length, 0);

    stripeState.nextRefund = 'failed'; // Stripe answers, but the refund itself failed
    r = await call('POST', `/api/orders/admin/${o.id}/refund`, { body: {}, headers: auth(USERS.admin) });
    assert.equal(r.status, 502);
    assert.equal(order.status, 'paid');
    assert.equal(state.products[0].stock, stock);

    stripeState.nextRefund = 'succeeded';
    stripeState.refundsByKey = {}; // (Stripe's idempotency window would have replayed the failed object; start clean)
    r = await call('POST', `/api/orders/admin/${o.id}/refund`, { body: {}, headers: auth(USERS.admin) });
    assert.equal(r.status, 200);
    assert.equal(order.status, 'cancelled');
    assert.equal(state.products[0].stock, stock + 2);
});

test('Stripe refund still "pending" at Stripe: cancelled, and the email says it was STARTED, not completed', async () => {
    seed();
    const o = await place({ user: USERS.owner });
    const order = await payWithStripe(o);
    stripeState.nextRefund = 'pending';
    const r = await call('POST', `/api/orders/admin/${o.id}/refund`, { body: {}, headers: auth(USERS.admin) });
    assert.equal(r.status, 200);
    assert.equal(order.refundStatus, 'pending');
    assert.deepEqual(state.calls.emails.find((e) => e[0] === 'status').slice(2), ['cancelled', 'pending']);
});

test('JazzCash/Easypaisa: no automated refund is ever faked; cancel + restock only after a recorded manual refund', async () => {
    seed();
    const o = await place({ user: USERS.owner, paymentMethod: 'jazzcash', qty: 2 });
    await call('POST', '/api/payments/jazzcash/initiate', { body: { orderId: o.id }, headers: { 'x-order-token': o.token } });
    const order = state.orders[0];
    assert.equal(order.gatewayPayment.amountMinor, 2799440, 'qty 2 = $99.98 = PKR 27,994.40 at 280');
    const quoted = { pp_Amount: String(order.gatewayPayment.amountMinor) };
    assert.match((await postJazz(jazzForm(o.id, order.paymentIntentId, quoted))).headers.get('location'), /success/);
    assert.equal(order.status, 'paid');
    const stock = state.products[0].stock;

    const flagged = await call('POST', `/api/orders/admin/${o.id}/refund`, { body: {}, headers: auth(USERS.admin) });
    assert.equal(flagged.status, 409);
    assert.equal(flagged.json.manualRequired, true);
    assert.match(flagged.json.message, /NOT been cancelled/);
    assert.equal(order.status, 'paid');
    assert.equal(order.refundStatus, 'manual_required');
    assert.equal(state.products[0].stock, stock);
    assert.equal(stripeState.refundCalls, 0);
    assert.equal(state.calls.emails.filter((e) => e[0] === 'status').length, 0);

    assert.equal((await call('POST', `/api/orders/admin/${o.id}/refund`, { body: { manualReference: 'x' }, headers: auth(USERS.admin) })).status, 400); // too short

    const done = await call('POST', `/api/orders/admin/${o.id}/refund`, { body: { manualReference: 'JC-REFUND-7781' }, headers: auth(USERS.admin) });
    assert.equal(done.status, 200, done.text);
    assert.equal(order.status, 'cancelled');
    assert.equal(order.refundStatus, 'manual_done');
    assert.equal(order.refundId, 'JC-REFUND-7781');
    assert.equal(state.products[0].stock, stock + 2);
    assert.equal(stripeState.refundCalls, 0, 'Stripe is never involved for JazzCash');
    assert.deepEqual(state.calls.emails.find((e) => e[0] === 'status').slice(2), ['cancelled', 'manual_done']);

    assert.equal((await call('POST', `/api/orders/admin/${o.id}/refund`, { body: { manualReference: 'JC-REFUND-7781' }, headers: auth(USERS.admin) })).status, 409);
    assert.equal(state.products[0].stock, stock + 2);
});

test('refund endpoint: admin only; only paid (or late-paid cancelled) online orders', async () => {
    seed();
    const o = await place({ user: USERS.owner });
    assert.equal((await call('POST', `/api/orders/admin/${o.id}/refund`, { body: {}, headers: auth(USERS.owner) })).status, 403);
    assert.equal((await call('POST', `/api/orders/admin/${o.id}/refund`, { body: {} })).status, 401);
    assert.equal((await call('POST', `/api/orders/admin/${o.id}/refund`, { body: {}, headers: auth(USERS.admin) })).status, 409); // pending: nothing paid
    assert.equal((await call('POST', `/api/orders/admin/nope/refund`, { body: {}, headers: auth(USERS.admin) })).status, 404);
    const cod = await place({ paymentMethod: 'cod' });
    await call('PATCH', `/api/orders/admin/${cod.id}/status`, { body: { status: 'paid' }, headers: auth(USERS.admin) });
    const r = await call('POST', `/api/orders/admin/${cod.id}/refund`, { body: {}, headers: auth(USERS.admin) });
    assert.equal(r.status, 409);
    assert.match(r.json.message, /Cash-on-delivery/);
    assert.equal(stripeState.refundCalls, 0);
});

/* ============================ 4. payment after cancellation ============================ */
test('late JazzCash payment: customer is NOT shown success, order stays cancelled and is flagged', async () => {
    seed();
    const o = await place({ user: USERS.owner, paymentMethod: 'jazzcash', qty: 2 });
    await call('POST', '/api/payments/jazzcash/initiate', { body: { orderId: o.id }, headers: { 'x-order-token': o.token } });
    const order = state.orders[0];
    assert.equal((await call('PATCH', `/api/orders/${o.id}/cancel`, { headers: auth(USERS.owner) })).status, 200);
    assert.equal(state.products[0].stock, 10);

    const quoted = { pp_Amount: String(order.gatewayPayment.amountMinor) };
    const cb = await postJazz(jazzForm(o.id, order.paymentIntentId, quoted)); // a genuine, correctly signed, correct-amount payment
    assert.equal(cb.status, 302);
    const loc = cb.headers.get('location');
    assert.match(loc, /status=late/);
    assert.doesNotMatch(loc, /status=success/);
    assert.equal(order.status, 'cancelled');
    assert.match(order.paymentIssue, /refund required/i);
    assert.equal(state.calls.emails.filter((e) => e[0] === 'paid').length, 0);
    assert.equal(state.calls.emits.filter((e) => e[1] === 'paid').length, 0);
    assert.equal(state.products[0].stock, 10, 'stock not taken again');

    // the gateway retries the same callback: same answer, still nothing changes
    assert.match((await postJazz(jazzForm(o.id, order.paymentIntentId, quoted))).headers.get('location'), /status=late/);
    assert.equal(order.status, 'cancelled');
});

test('late Easypaisa payment: same - "late", never success', async () => {
    seed();
    const o = await place({ user: USERS.owner, paymentMethod: 'easypaisa' });
    await call('POST', '/api/payments/easypaisa/initiate', { body: { orderId: o.id }, headers: { 'x-order-token': o.token } });
    await call('PATCH', `/api/orders/${o.id}/cancel`, { headers: auth(USERS.owner) });
    const p = { orderRefNum: o.id, amount: '13997.20', status: 'SUCCESS', transactionId: 'EP9' };
    const cb = await call('POST', '/api/payments/easypaisa/callback', { raw: new URLSearchParams({ ...p, merchantHashedResp: generateSecureHash(p, process.env.EASYPAISA_HASH_KEY) }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    assert.match(cb.headers.get('location'), /status=late/);
    assert.equal(state.orders[0].status, 'cancelled');
    assert.ok(state.orders[0].paymentIssue);
    assert.equal(state.calls.emails.filter((e) => e[0] === 'paid').length, 0);
});

test('late Stripe payment is flagged; the admin refund then returns the money WITHOUT restocking twice', async () => {
    seed();
    const o = await place({ user: USERS.owner, qty: 2 });
    const headers = { 'x-order-token': o.token };
    await call('POST', '/api/payments/stripe/create-intent', { body: { orderId: o.id }, headers });
    await call('PATCH', `/api/orders/${o.id}/cancel`, { headers: auth(USERS.owner) });
    assert.equal(state.products[0].stock, 10);
    const order = state.orders[0];
    stripeState.intents[order.paymentIntentId].status = 'succeeded';
    const late = await call('POST', `/api/payments/stripe/confirm/${o.id}`, { body: {}, headers });
    assert.equal(late.status, 409);
    assert.match(late.json.message, /cancelled before your payment arrived/);
    assert.ok(order.paymentIssue);

    const r = await call('POST', `/api/orders/admin/${o.id}/refund`, { body: {}, headers: auth(USERS.admin) });
    assert.equal(r.status, 200, r.text);
    assert.equal(order.refundStatus, 'succeeded');
    assert.equal(order.status, 'cancelled');
    assert.equal(state.products[0].stock, 10, 'no second restock');
    assert.equal(state.calls.emails.filter((e) => e[0] === 'status').length, 1); // the customer-cancel email only
});
