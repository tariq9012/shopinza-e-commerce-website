const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRequestedItems, priceItems, computeTotals, OrderInputError } = require('../utils/orderPricing');
const { checkTransition } = require('../utils/orderStatus');
const { generateOrderAccessToken, canAccessOrder, hashOrderAccessToken, isValidObjectId } = require('../utils/orderAccess');
const { verifyJazzCashCallback, verifyEasypaisaCallback } = require('../utils/gatewayVerify');
const { generateSecureHash } = require('../utils/secureHash');
const { cleanShipping, escapeHtml, isString } = require('../utils/validate');
const { isAllowedOrigin } = require('../utils/origins');

const throwsInput = (fn, re) => assert.throws(fn, (e) => e instanceof OrderInputError && (!re || re.test(e.message)));

/* ---------------- pricing: the client can never set money ---------------- */
test('quantities must be whole numbers >= 1 (negative qty would INCREASE stock)', () => {
    for (const qty of [0, -1, -5, 1.5, '2', null, undefined, NaN, Infinity]) {
        throwsInput(() => normalizeRequestedItems([{ productId: 'a', qty }]), /whole numbers/);
    }
});

test('cart shape is validated', () => {
    throwsInput(() => normalizeRequestedItems([]), /empty/);
    throwsInput(() => normalizeRequestedItems('nope'), /empty/);
    throwsInput(() => normalizeRequestedItems([null]), /invalid/);
    throwsInput(() => normalizeRequestedItems([{ productId: { $ne: 1 }, qty: 1 }]), /invalid/);
    throwsInput(() => normalizeRequestedItems([{ productId: 'a', qty: 1, color: { $gt: '' } }]), /invalid/);
    throwsInput(() => normalizeRequestedItems([{ productId: 'a', qty: 21 }]), /at most 20/);
    throwsInput(() => normalizeRequestedItems(Array.from({ length: 51 }, (_, i) => ({ productId: `p${i}`, qty: 1 }))), /at most 50/);
});

test('duplicate lines are merged, and the merged qty is still capped', () => {
    const lines = normalizeRequestedItems([{ productId: 'a', qty: 2 }, { productId: 'a', qty: 3 }, { productId: 'b', qty: 1 }]);
    assert.equal(lines.length, 2);
    assert.equal(lines.find((l) => l.productId === 'a').qty, 5);
    throwsInput(() => normalizeRequestedItems([{ productId: 'a', qty: 15 }, { productId: 'a', qty: 15 }]), /at most 20/);
});

test('price, name and image come from the DATABASE, whatever the client sent', () => {
    const lines = normalizeRequestedItems([{ productId: 'shirt', qty: 2, price: 0.01, name: 'HACKED', image: 'javascript:alert(1)' }]);
    const { items, subtotalCents } = priceItems(lines, new Map([['shirt', { slug: 'shirt', name: 'Real Shirt', price: 49.99, image: 'https://img/x.jpg', variants: [] }]]));
    assert.equal(items[0].price, 49.99);
    assert.equal(items[0].name, 'Real Shirt');
    assert.equal(items[0].image, 'https://img/x.jpg');
    assert.equal(subtotalCents, 9998);
});

test('unknown products and invalid variants are rejected', () => {
    const products = new Map([['tee', { slug: 'tee', name: 'Tee', price: 10, image: 'i', variants: [{ color: 'Red', size: 'M', stock: 3 }] }]]);
    throwsInput(() => priceItems(normalizeRequestedItems([{ productId: 'ghost', qty: 1 }]), products), /no longer available/);
    throwsInput(() => priceItems(normalizeRequestedItems([{ productId: 'tee', qty: 1 }]), products), /colour and size/);
    throwsInput(() => priceItems(normalizeRequestedItems([{ productId: 'tee', qty: 1, color: 'Blue', size: 'M' }]), products), /colour and size/);
    const ok = priceItems(normalizeRequestedItems([{ productId: 'tee', qty: 1, color: 'Red', size: 'M' }]), products);
    assert.equal(ok.items[0].color, 'Red');
});

test('a product WITHOUT variants ignores colour/size sent by the client', () => {
    const products = new Map([['mug', { slug: 'mug', name: 'Mug', price: 5, image: 'i', variants: [] }]]);
    const { items } = priceItems(normalizeRequestedItems([{ productId: 'mug', qty: 1, color: 'Red', size: 'XL' }]), products);
    assert.equal(items[0].color, undefined);
    assert.equal(items[0].size, undefined);
});

test('money maths is exact (integer cents) and discounts are capped', () => {
    const products = new Map([['x', { slug: 'x', name: 'X', price: 0.1, image: 'i', variants: [] }]]);
    const { subtotalCents } = priceItems(normalizeRequestedItems([{ productId: 'x', qty: 3 }]), products);
    assert.equal(subtotalCents, 30); // not 30.000000000000004
    assert.equal(computeTotals({ subtotalCents: 1000, shippingCents: 2500, discountCents: 999999 }).total, 25); // discount capped at the subtotal
    assert.equal(computeTotals({ subtotalCents: 1000, shippingCents: 0, discountCents: -500 }).total, 10); // negative discount ignored
});

/* ---------------- order status rules ---------------- */
test('status transitions: cancelled and delivered are final', () => {
    const t = (from, to, extra = {}) => checkTransition({ status: from, paymentMethod: 'stripe', ...extra }, to).ok;
    assert.equal(t('cancelled', 'pending'), false);
    assert.equal(t('cancelled', 'paid'), false);
    assert.equal(t('cancelled', 'cancelled'), false); // cancelling twice = double restock
    assert.equal(t('delivered', 'cancelled'), false);
    assert.equal(t('shipped', 'cancelled'), false);
    assert.equal(t('paid', 'pending'), false);
    assert.equal(t('pending', 'delivered'), false);
    assert.equal(t('pending', 'bogus'), false);
    assert.equal(t('paid', 'shipped'), true);
    assert.equal(t('shipped', 'delivered'), true);
    assert.equal(t('pending', 'cancelled'), true);
    assert.equal(t('pending', 'paid'), true);
});

test('unpaid online-payment orders cannot ship, cash-on-delivery can', () => {
    assert.equal(checkTransition({ status: 'pending', paymentMethod: 'stripe' }, 'shipped').ok, false);
    assert.equal(checkTransition({ status: 'pending', paymentMethod: 'easypaisa' }, 'shipped').ok, false);
    assert.equal(checkTransition({ status: 'pending', paymentMethod: 'cod' }, 'shipped').ok, true);
});

/* ---------------- guest order access ---------------- */
test('order access: owner, admin or token holder only', () => {
    const { token, hash } = generateOrderAccessToken();
    const order = { user: 'u1', accessTokenHash: hash };
    assert.equal(hash, hashOrderAccessToken(token));
    assert.equal(canAccessOrder(order, { userId: 'u1' }), true);
    assert.equal(canAccessOrder(order, { userId: 'u2' }), false);
    assert.equal(canAccessOrder(order, { isAdmin: true }), true);
    assert.equal(canAccessOrder(order, { token }), true);
    assert.equal(canAccessOrder(order, { token: token.slice(1) + 'x' }), false);
    assert.equal(canAccessOrder(order, {}), false);
    assert.equal(canAccessOrder(null, { token }), false);
    assert.equal(canAccessOrder({ user: 'u1' }, { token }), false); // no hash stored -> never matches
    assert.equal(canAccessOrder({ accessTokenHash: hash }, { userId: undefined }), false); // guest order, caller not signed in
    assert.equal(isValidObjectId('507f1f77bcf86cd799439011'), true);
    assert.equal(isValidObjectId('../etc'), false);
    assert.equal(isValidObjectId({ $ne: 1 }), false);
});

/* ---------------- gateway verification ---------------- */
const jazzOrder = {
    _id: '507f1f77bcf86cd799439011', total: 49.99, currency: 'USD', paymentMethod: 'jazzcash', paymentIntentId: 'T1700000000', status: 'pending',
    gatewayPayment: { provider: 'jazzcash', currency: 'PKR', amountMinor: 1399720, rate: 280, orderTotalMinor: 4999, orderCurrency: 'USD' },
};
function jazzBody(over = {}, salt = 'salt123') {
    const params = { pp_BillReference: jazzOrder._id, pp_TxnRefNo: 'T1700000000', pp_Amount: '1399720', pp_TxnCurrency: 'PKR', pp_ResponseCode: '000', pp_Language: 'EN', ...over };
    return { ...params, pp_SecureHash: generateSecureHash(params, salt) };
}

test('JazzCash: only a fully matching, correctly signed callback is accepted', () => {
    assert.equal(verifyJazzCashCallback(jazzBody(), jazzOrder, 'salt123').ok, true);
    assert.match(verifyJazzCashCallback({ ...jazzBody(), pp_Amount: '1' }, jazzOrder, 'salt123').reason, /hash/); // tampered field
    assert.equal(verifyJazzCashCallback(jazzBody({}, 'wrong-salt'), jazzOrder, 'salt123').ok, false); // signed with another key
    assert.match(verifyJazzCashCallback(jazzBody({ pp_Amount: '100' }), jazzOrder, 'salt123').reason, /amount/); // valid hash, but underpaid
    assert.match(verifyJazzCashCallback(jazzBody({ pp_TxnRefNo: 'T999' }), jazzOrder, 'salt123').reason, /transaction/);
    assert.match(verifyJazzCashCallback(jazzBody({ pp_BillReference: 'other' }), jazzOrder, 'salt123').reason, /order/);
    assert.equal(verifyJazzCashCallback(jazzBody({ pp_ResponseCode: '124' }), jazzOrder, 'salt123').declined, true);
    const noHash = jazzBody(); delete noHash.pp_SecureHash;
    assert.equal(verifyJazzCashCallback(noHash, jazzOrder, 'salt123').ok, false);
    assert.equal(verifyJazzCashCallback(jazzBody(), jazzOrder, '').ok, false); // salt not configured
    assert.equal(verifyJazzCashCallback(jazzBody(), null, 'salt123').ok, false);
});

const epOrder = {
    _id: '507f1f77bcf86cd799439011', total: 49.99, currency: 'USD', paymentMethod: 'easypaisa', paymentIntentId: '507f1f77bcf86cd799439011',
    gatewayPayment: { provider: 'easypaisa', currency: 'PKR', amountMinor: 1399720, rate: 280, orderTotalMinor: 4999, orderCurrency: 'USD' },
};
function epBody(over = {}, key = 'ephash') {
    const params = { orderRefNum: epOrder._id, amount: '13997.20', status: 'SUCCESS', transactionId: 'EP42', ...over };
    return { ...params, merchantHashedResp: generateSecureHash(params, key) };
}

test('Easypaisa: an UNSIGNED or unverifiable callback never marks an order paid (fails closed)', () => {
    // the old code accepted exactly this: anyone could POST it
    assert.equal(verifyEasypaisaCallback({ orderRefNum: epOrder._id, status: 'SUCCESS' }, epOrder, 'ephash').ok, false);
    assert.match(verifyEasypaisaCallback({ orderRefNum: epOrder._id, status: 'SUCCESS' }, epOrder, 'ephash').reason, /not signed/);
    assert.equal(verifyEasypaisaCallback(epBody(), epOrder, 'ephash').ok, true);
    assert.equal(verifyEasypaisaCallback(epBody({}, 'guess'), epOrder, 'ephash').ok, false);
    assert.match(verifyEasypaisaCallback(epBody({ amount: '1.00' }), epOrder, 'ephash').reason, /amount/);
    assert.match(verifyEasypaisaCallback(epBody({ amount: '49.99' }), epOrder, 'ephash').reason, /amount/); // the USD number is NOT a PKR amount
    assert.match(verifyEasypaisaCallback(epBody({ orderRefNum: 'zzz' }), epOrder, 'ephash').reason, /order/);
    assert.equal(verifyEasypaisaCallback(epBody({ status: 'FAILED' }), epOrder, 'ephash').declined, true);
    assert.equal(verifyEasypaisaCallback(epBody(), epOrder, '').ok, false); // key not configured
    const noAmount = epBody(); delete noAmount.amount;
    assert.equal(verifyEasypaisaCallback(noAmount, epOrder, 'ephash').ok, false);
});

/* ---------------- input validation / origins ---------------- */
test('shipping is whitelisted and validated', () => {
    const good = { firstName: 'A', lastName: 'B', email: 'A@B.CO', address: 'x', city: 'y', state: 'z', zip: '1', phone: '123', role: 'admin', $where: '1' };
    const { shipping } = cleanShipping(good);
    assert.equal(shipping.email, 'a@b.co');
    assert.equal('role' in shipping, false);
    assert.equal('$where' in shipping, false);
    assert.ok(cleanShipping({ ...good, email: 'nope' }).error);
    assert.ok(cleanShipping({ ...good, city: { $ne: 1 } }).error);
    assert.ok(cleanShipping({ ...good, firstName: 'x'.repeat(500) }).error);
    assert.ok(cleanShipping(null).error);
    assert.equal(isString({ $gt: '' }), false);
    assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});

test('CORS origins: production allows only same-origin + CLIENT_ORIGIN', () => {
    const env = { ...process.env };
    process.env.VERCEL = '1';
    process.env.CLIENT_ORIGIN = '';
    assert.equal(isAllowedOrigin(undefined), true); // curl / Stripe / same-origin GET
    assert.equal(isAllowedOrigin('https://evil.example', { host: 'shop.example' }), false);
    assert.equal(isAllowedOrigin('https://shop.example', { host: 'shop.example' }), true); // same origin
    assert.equal(isAllowedOrigin('https://shop.example', { 'x-forwarded-host': 'shop.example', host: 'internal' }), true);
    process.env.CLIENT_ORIGIN = 'https://www.shop.example/';
    assert.equal(isAllowedOrigin('https://www.shop.example', { host: 'shop.example' }), true);
    delete process.env.VERCEL; process.env.CLIENT_ORIGIN = '';
    assert.equal(isAllowedOrigin('http://127.0.0.1:5501', { host: 'localhost:5000' }), true); // local dev stays open
    process.env.NODE_ENV = 'production';
    assert.equal(isAllowedOrigin('http://127.0.0.1:5501', { host: 'localhost:5000' }), false);
    Object.assign(process.env, env); if (!('VERCEL' in env)) delete process.env.VERCEL; if (!('NODE_ENV' in env)) delete process.env.NODE_ENV;
});

/* ================= Phase 2.1: currency policy ================= */
const { quoteGatewayAmount, getUsdToPkrRate, formatMinor, STORE_CURRENCY } = require('../config/currency');
const { createTrackingToken, verifyTrackingToken } = require('../utils/orderTracking');

test('currency policy: USD store, Stripe needs no conversion, PKR gateways need a configured rate', () => {
    const saved = process.env.USD_TO_PKR_RATE;
    const order = { total: 49.99, currency: 'USD' };
    assert.equal(STORE_CURRENCY, 'USD');

    delete process.env.USD_TO_PKR_RATE;
    assert.equal(getUsdToPkrRate(), null);
    const noRate = quoteGatewayAmount(order, 'jazzcash');
    assert.equal(noRate.ok, false);
    assert.equal(noRate.code, 'CURRENCY_NOT_CONFIGURED');
    assert.match(noRate.message, /not configured for this currency/);
    assert.equal(quoteGatewayAmount(order, 'easypaisa').ok, false);

    for (const bad of ['', '  ', 'abc', '0', '-280', 'NaN', 'Infinity']) {
        process.env.USD_TO_PKR_RATE = bad;
        assert.equal(getUsdToPkrRate(), null, `rate ${JSON.stringify(bad)} must be rejected`);
        assert.equal(quoteGatewayAmount(order, 'jazzcash').ok, false);
    }

    // Stripe charges the store currency as-is - no rate involved, even when none is configured
    delete process.env.USD_TO_PKR_RATE;
    const stripe = quoteGatewayAmount(order, 'stripe');
    assert.equal(stripe.ok, true);
    assert.equal(stripe.snapshot.currency, 'USD');
    assert.equal(stripe.snapshot.amountMinor, 4999);

    process.env.USD_TO_PKR_RATE = '280';
    const pkr = quoteGatewayAmount(order, 'jazzcash');
    assert.equal(pkr.ok, true);
    assert.equal(pkr.snapshot.currency, 'PKR');
    assert.equal(pkr.snapshot.amountMinor, 1399720); // 4999 USD-cents x 280 = PKR paisa, NOT 4999
    assert.notEqual(pkr.snapshot.amountMinor, 4999, 'a USD amount must never be reused as a PKR amount');
    assert.equal(pkr.snapshot.orderTotalMinor, 4999);
    assert.equal(pkr.snapshot.rate, 280);
    assert.equal(formatMinor(pkr.snapshot.amountMinor, 'PKR'), 'PKR 13,997.20');

    process.env.USD_TO_PKR_RATE = '278.5';
    assert.equal(quoteGatewayAmount({ total: 10, currency: 'USD' }, 'easypaisa').snapshot.amountMinor, 278500);

    assert.equal(quoteGatewayAmount(order, 'bitcoin').ok, false);
    assert.equal(quoteGatewayAmount({ total: 10, currency: 'EUR' }, 'jazzcash').ok, false); // no conversion path -> refuse
    if (saved === undefined) delete process.env.USD_TO_PKR_RATE; else process.env.USD_TO_PKR_RATE = saved;
});

test('gateway callbacks never match against the USD total, and need a quote snapshot', () => {
    const noSnapshot = { ...jazzOrder, gatewayPayment: undefined };
    assert.match(verifyJazzCashCallback(jazzBody(), noSnapshot, 'salt123').reason, /no quoted/);
    const wrongProvider = { ...jazzOrder, gatewayPayment: { ...jazzOrder.gatewayPayment, provider: 'easypaisa' } };
    assert.equal(verifyJazzCashCallback(jazzBody(), wrongProvider, 'salt123').ok, false);
    // correctly signed, but the amount is the USD number (4999) presented as PKR paisa
    assert.match(verifyJazzCashCallback(jazzBody({ pp_Amount: '4999' }), jazzOrder, 'salt123').reason, /amount/);
    // correctly signed, right number, but the gateway says the currency is USD
    assert.match(verifyJazzCashCallback(jazzBody({ pp_TxnCurrency: 'USD' }), jazzOrder, 'salt123').reason, /currency/);
    assert.match(verifyEasypaisaCallback(epBody(), { ...epOrder, gatewayPayment: undefined }, 'ephash').reason, /no quoted/);
});

/* ================= Phase 2.1: signed email tracking token ================= */
const ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

test('tracking token: bound to one order, expiring, unforgeable, read-only by construction', () => {
    process.env.ORDER_TRACKING_SECRET = 'unit-secret';
    const token = createTrackingToken(ID_A);
    assert.match(token, /^[a-f0-9]{24}\.\d+\.[A-Za-z0-9_-]+$/);
    assert.equal(verifyTrackingToken(token, ID_A), true);
    assert.equal(verifyTrackingToken(token, ID_B), false, 'token for order A must fail for order B');
    // re-pointing the token at another order (keeping A's signature) fails
    assert.equal(verifyTrackingToken(token.replace(ID_A, ID_B), ID_B), false);
    // extending the expiry invalidates the signature
    const [id, exp, sig] = token.split('.');
    assert.equal(verifyTrackingToken(`${id}.${Number(exp) + 99999}.${sig}`, ID_A), false);
    assert.equal(verifyTrackingToken(`${id}.${exp}.${sig.slice(0, -2)}xx`, ID_A), false);
    for (const junk of ['', 'x', 'a.b', 'a.b.c.d', `${ID_A}.abc.sig`, `${ID_A}..`, null, undefined, 42, {}, 'x'.repeat(500)]) {
        assert.equal(verifyTrackingToken(junk, ID_A), false);
    }
    // expired
    const old = createTrackingToken(ID_A, Date.now() - 181 * 24 * 3600 * 1000);
    assert.equal(verifyTrackingToken(old, ID_A), false);
    // signed with another secret = forged
    process.env.ORDER_TRACKING_SECRET = 'attacker-guess';
    const forged = createTrackingToken(ID_A);
    process.env.ORDER_TRACKING_SECRET = 'unit-secret';
    assert.equal(verifyTrackingToken(forged, ID_A), false);
    assert.equal(verifyTrackingToken(token, ID_A), true);
});

test('tracking token: production without ORDER_TRACKING_SECRET issues nothing and accepts nothing', () => {
    const saved = { s: process.env.ORDER_TRACKING_SECRET, v: process.env.VERCEL };
    process.env.ORDER_TRACKING_SECRET = 'unit-secret';
    const token = createTrackingToken(ID_A);
    delete process.env.ORDER_TRACKING_SECRET;
    process.env.VERCEL = '1';
    assert.equal(createTrackingToken(ID_A), null);
    assert.equal(verifyTrackingToken(token, ID_A), false);
    process.env.ORDER_TRACKING_SECRET = saved.s || 'unit-secret';
    if (saved.v === undefined) delete process.env.VERCEL; else process.env.VERCEL = saved.v;
});

/* ================= Phase 2.1: emails ================= */
test('order emails (placed, paid, status) carry a working guest tracking link in the URL FRAGMENT', async () => {
    process.env.ORDER_TRACKING_SECRET = 'unit-secret';
    process.env.FRONTEND_URL = 'https://shop.example';
    const path = require('node:path');
    const sent = [];
    const mailerPath = require.resolve('../utils/mailer');
    require.cache[mailerPath] = { id: mailerPath, filename: mailerPath, loaded: true, exports: { sendMail: async (m) => sent.push(m) } };
    delete require.cache[require.resolve('../utils/orderMailer')];
    const mailer = require('../utils/orderMailer');

    const order = { _id: ID_A, total: 49.99, subtotal: 49.99, shippingCost: 0, currency: 'USD', status: 'shipped',
        items: [{ name: 'Shirt', qty: 1, price: 49.99 }], shipping: { firstName: 'Ali', lastName: 'K', email: 'a@b.co', address: 'x', city: 'y', state: 'z', zip: '1' } };
    await mailer.sendOrderPlacedEmail(order);
    await mailer.sendOrderPaidEmail({ ...order, status: 'paid' });
    await mailer.sendOrderStatusEmail(order);
    await mailer.sendOrderStatusEmail({ ...order, status: 'cancelled' });
    assert.equal(sent.length, 4);
    for (const mail of sent) {
        const m = /href="(https:\/\/shop\.example\/order-confirmation\.html\?orderId=([a-f0-9]{24})#track=([^"]+))"/.exec(mail.html);
        assert.ok(m, `no tracking link in: ${mail.subject}`);
        assert.equal(m[2], ID_A);
        assert.equal(verifyTrackingToken(m[3], ID_A), true, 'the emailed token must verify');
        assert.equal(m[1].split('#')[0].includes('track='), false, 'token must NOT be in the query string');
    }
    void path;
});

test('cancellation email states ONLY what actually happened', () => {
    const { cancelledCopy } = require('../utils/orderMailer');
    const base = { total: 49.99, currency: 'USD' };
    const t = (o) => cancelledCopy({ ...base, ...o }).body;

    assert.match(t({ refundStatus: 'succeeded' }), /refunded \$49\.99/);
    assert.match(t({ refundStatus: 'pending' }), /started a refund/);
    assert.doesNotMatch(t({ refundStatus: 'pending' }), /we've refunded/i);
    assert.match(t({ refundStatus: 'manual_done' }), /issued your refund/);

    const unpaid = t({ refundStatus: 'none' });
    assert.match(unpaid, /No payment had been received/);
    assert.doesNotMatch(unpaid, /will be refunded|we've refunded|started a refund/i);
    assert.doesNotMatch(t({}), /will be refunded|we've refunded/i);

    const paidNoRefund = t({ paidAt: new Date(), refundStatus: 'none' });
    assert.match(paidNoRefund, /contact support/);
    assert.doesNotMatch(paidNoRefund, /we've refunded|started a refund|will be refunded/i);
    assert.doesNotMatch(t({ paidAt: new Date(), refundStatus: 'failed' }), /we've refunded|started a refund/i);
    assert.doesNotMatch(t({ paidAt: new Date(), refundStatus: 'manual_required' }), /we've refunded|started a refund/i);
});

/* ================= payment-method switching: stale attempts ================= */
test('stale attempts: after the method changed, a genuine signed callback is STALE and never ok', () => {
    // JazzCash order switched to COD / Stripe
    for (const paymentMethod of ['cod', 'stripe', 'easypaisa']) {
        const v = verifyJazzCashCallback(jazzBody(), { ...jazzOrder, paymentMethod }, 'salt123');
        assert.equal(v.ok, false, paymentMethod);
        assert.equal(v.stale, true, paymentMethod);
        assert.equal(v.succeeded, true, 'the gateway says money was taken - the route must flag it for reconciliation');
    }
    // the provider reference was cleared by the switch
    const cleared = { ...jazzOrder, paymentIntentId: undefined, gatewayPayment: undefined };
    assert.equal(verifyJazzCashCallback(jazzBody(), cleared, 'salt123').stale, true);
    // an older attempt of the SAME method (payment restarted, new transaction reference)
    const restarted = { ...jazzOrder, paymentIntentId: 'T1999999999' };
    const old = verifyJazzCashCallback(jazzBody(), restarted, 'salt123');
    assert.equal(old.ok, false);
    assert.equal(old.stale, true);
    // a stale DECLINED callback is reported as not-succeeded (nothing to reconcile)
    assert.equal(verifyJazzCashCallback(jazzBody({ pp_ResponseCode: '124' }), { ...jazzOrder, paymentMethod: 'cod' }, 'salt123').succeeded, false);
    // a FORGED stale callback is not even recognised as stale (the signature is checked first)
    assert.equal(verifyJazzCashCallback({ ...jazzBody(), pp_SecureHash: 'beef' }, { ...jazzOrder, paymentMethod: 'cod' }, 'salt123').stale, undefined);

    for (const paymentMethod of ['cod', 'stripe', 'jazzcash']) {
        const v = verifyEasypaisaCallback(epBody(), { ...epOrder, paymentMethod }, 'ephash');
        assert.equal(v.ok, false, paymentMethod);
        assert.equal(v.stale, true, paymentMethod);
    }
    assert.equal(verifyEasypaisaCallback(epBody(), { ...epOrder, paymentMethod: 'cod', paymentIntentId: undefined, gatewayPayment: undefined }, 'ephash').stale, true);
    assert.equal(verifyEasypaisaCallback({ ...epBody(), merchantHashedResp: 'beef' }, { ...epOrder, paymentMethod: 'cod' }, 'ephash').stale, undefined);
});
