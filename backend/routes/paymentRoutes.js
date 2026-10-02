const crypto = require('crypto');
const express = require('express');
const stripe = require('../config/stripe');
const Order = require('../models/Order');
const { optionalAuth } = require('../middleware/auth');
const { generateSecureHash } = require('../utils/secureHash');
const { sendOrderPaidEmail, sendOrderPlacedEmail } = require('../utils/orderMailer');
const { emitOrderUpdate } = require('../socket');
const { toCents } = require('../utils/money');
const { canAccessOrder, tokenFromRequest, isValidObjectId } = require('../utils/orderAccess');
const { verifyJazzCashCallback, verifyEasypaisaCallback } = require('../utils/gatewayVerify');
const { STORE_CURRENCY, getUsdToPkrRate, formatMinor, quoteGatewayAmount } = require('../config/currency');

const router = express.Router();

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://127.0.0.1:5500').replace(/\/$/, '');
const PAID_ONWARD_STATUSES = ['paid', 'shipped', 'delivered'];
const STRIPE_CURRENCY = STORE_CURRENCY.toLowerCase(); // Stripe charges in the store currency - no conversion

function formatGatewayDateTime(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
        `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
    );
}

/**
 * Marks an order as paid - ATOMICALLY and idempotently.
 *
 * The status flip is one conditional update (`status` must still be "pending"),
 * so when a Stripe webhook, the browser's confirm call and a gateway retry all
 * arrive at once, exactly ONE of them wins: one status change, one email, one
 * live-update push. Callers must have verified the payment (signature / amount /
 * reference) BEFORE calling this.
 *
 * @returns {{ order, changed: boolean, lateAfterCancel: boolean } | null}
 */
async function markOrderPaid(orderId, { paymentMethod, transactionId }) {
    const order = await Order.findOneAndUpdate(
        { _id: orderId, status: 'pending' },
        { $set: { status: 'paid', paymentMethod, transactionId, paidAt: new Date() } },
        { new: true }
    );

    if (order) {
        sendOrderPaidEmail(order).catch((err) => console.error('Order paid email error:', err));
        emitOrderUpdate(order); // live-push "paid" status to anyone watching this order right now
        return { order, changed: true, lateAfterCancel: false };
    }

    const existing = await Order.findById(orderId);
    if (!existing) return null;

    if (PAID_ONWARD_STATUSES.includes(existing.status)) {
        return { order: existing, changed: false, lateAfterCancel: false }; // already processed - do nothing
    }

    if (existing.status === 'cancelled') {
        // Money arrived for an order that was already cancelled (its stock was given
        // back). We must NOT quietly mark it paid - that would ship goods we no longer
        // hold. Flag it so an admin refunds the customer.
        await Order.updateOne(
            { _id: orderId, status: 'cancelled', paymentIssue: { $exists: false } },
            { $set: { paymentIssue: `Payment (${paymentMethod} ${transactionId}) received after the order was cancelled - refund required.` } }
        );
        console.error(`PAYMENT AFTER CANCEL: order ${orderId} via ${paymentMethod} (${transactionId}) needs a manual refund.`);
        return { order: existing, changed: false, lateAfterCancel: true };
    }

    return { order: existing, changed: false, lateAfterCancel: false };
}

/**
 * Loads req.order for routes that act on ONE order on the customer's behalf.
 * Caller must be the signed-in owner or present the order's access token
 * (X-Order-Token); otherwise it's a plain 404 (no order-id probing).
 */
function orderIdFrom(req) {
    return (req.body && req.body.orderId) || req.params.orderId;
}

async function requireOrderAccess(req, res, next) {
    try {
        const orderId = orderIdFrom(req);
        if (!orderId) return res.status(400).json({ message: 'orderId is required.' });
        if (!isValidObjectId(String(orderId))) return res.status(404).json({ message: 'Order not found.' });

        const order = await Order.findById(orderId).select('+accessTokenHash');
        if (!canAccessOrder(order, { userId: req.userId, token: tokenFromRequest(req) })) {
            return res.status(404).json({ message: 'Order not found.' });
        }

        req.order = order;
        next();
    } catch (err) {
        console.error('Order access check error:', err);
        res.status(500).json({ message: 'Could not load this order.' });
    }
}

/** Restarting a gateway payment replaces the previous attempt: archive it so a late payment on it can be reconciled. */
function withArchivedAttempt(order, update) {
    const g = order.gatewayPayment;
    if (g && g.provider && order.paymentIntentId && order.paymentMethod !== 'stripe') {
        return {
            ...update,
            $push: { abandonedGatewayAttempts: { provider: g.provider, reference: order.paymentIntentId, amountMinor: g.amountMinor, currency: g.currency, abandonedAt: new Date() } },
        };
    }
    return update;
}

/**
 * A correctly signed callback for a payment attempt that is no longer the current one (method switched,
 * or the payment was restarted). It must not change the order's STATUS. If the gateway says money was
 * taken, the order is flagged so an admin reconciles/refunds it by hand.
 */
async function flagStaleGatewayPayment(order, provider, reference) {
    await Order.updateOne(
        { _id: order._id, paymentIssue: { $exists: false } },
        { $set: { paymentIssue: `${provider} reported a successful payment (${reference || 'no reference'}) for an attempt that was replaced when the payment method was changed - reconcile and refund it.` } }
    );
    console.error(`STALE ${provider} PAYMENT: order ${order._id} (${reference || 'no reference'}) needs manual reconciliation.`);
}

function assertPayable(order, method) {
    if (order.status !== 'pending') return 'This order has already been paid or cancelled.';
    if (order.paymentMethod !== method) return `This order was not placed with ${method}.`;
    return null;
}

// GET /api/payments/config  - public config the frontend needs to boot Stripe.js
router.get('/config', (_req, res) => {
    const rate = getUsdToPkrRate();
    res.json({
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
        storeCurrency: STORE_CURRENCY,
        // JazzCash / Easypaisa charge PKR. They are only offered when their credentials AND a
        // deliberate USD->PKR rate are configured; the PKR amount is shown to the customer first.
        gateways: {
            jazzcash: { currency: 'PKR', usdToPkrRate: rate, available: Boolean(process.env.JAZZCASH_MERCHANT_ID) && rate !== null },
            easypaisa: { currency: 'PKR', usdToPkrRate: rate, available: Boolean(process.env.EASYPAISA_STORE_ID) && rate !== null },
        },
    });
});

/** What the customer is told BEFORE being redirected: the exact currency and amount the provider will charge. */
function gatewayDisplay(order, snapshot) {
    return {
        provider: snapshot.provider,
        currency: snapshot.currency,
        amountMinor: snapshot.amountMinor,
        amount: formatMinor(snapshot.amountMinor, snapshot.currency),
        orderTotal: formatMinor(snapshot.orderTotalMinor, snapshot.orderCurrency),
        rate: snapshot.rate,
    };
}

/* ============================================================
   Switching the payment method of an UNPAID order
   (customer declined the PKR confirmation, a gateway failed to start, a card was declined...)
   ============================================================ */

const SWITCHABLE_METHODS = ['cod', 'stripe', 'jazzcash', 'easypaisa'];
const STRIPE_CANCELLABLE = ['requires_payment_method', 'requires_confirmation', 'requires_action'];

function switchedOrderView(order) {
    const obj = typeof order.toObject === 'function' ? order.toObject() : { ...order };
    delete obj.accessTokenHash;
    return obj;
}

// POST /api/payments/switch-method  - body: { orderId, paymentMethod }
//
// Moves an EXISTING pending order to another payment method WITHOUT creating a second order:
// the order id, access token, items, totals, stock reservation and coupon redemption all stay exactly
// as they are. Allowed for the signed-in owner or the browser holding the checkout X-Order-Token
// (requireOrderAccess) - NOT for the read-only emailed tracking token.
//   - a live Stripe PaymentIntent is inspected first: succeeded/processing => refuse; otherwise it is
//     CANCELLED at Stripe before the reference is cleared, so it can never charge this order later;
//   - JazzCash/Easypaisa state is cleared (the old attempt is archived for reconciliation), and the
//     callbacks then reject that old attempt (utils/gatewayVerify.js) so it can't pay the order;
//   - the change is ONE conditional update (still pending, same method, same intent), so it can't
//     race a payment that lands at the same moment. Nothing here ever marks the order paid.
router.post('/switch-method', optionalAuth, requireOrderAccess, async (req, res) => {
    try {
        const target = req.body && req.body.paymentMethod;
        if (typeof target !== 'string' || !SWITCHABLE_METHODS.includes(target)) {
            return res.status(400).json({ message: 'Invalid payment method.' });
        }

        const order = req.order;
        if (order.status !== 'pending') {
            return res.status(409).json({ message: 'Only an unpaid order can change its payment method. This order has already been paid, cancelled or shipped.' });
        }
        if (order.paymentMethod === target) {
            return res.json({ order: switchedOrderView(order), switched: false }); // already on it - nothing to do
        }

        // Refuse BEFORE touching anything when the target can't be used (so a failed switch changes nothing)
        if (target === 'jazzcash' || target === 'easypaisa') {
            const configured = target === 'jazzcash' ? process.env.JAZZCASH_MERCHANT_ID : process.env.EASYPAISA_STORE_ID;
            if (!configured) {
                return res.status(503).json({ message: `${target === 'jazzcash' ? 'JazzCash' : 'Easypaisa'} is not configured yet. Please choose another payment method.` });
            }
            const quote = quoteGatewayAmount(order, target);
            if (!quote.ok) return res.status(503).json({ code: quote.code, message: quote.message });
        }

        // ---- leaving Stripe: make sure no live intent can charge this order later ----
        if (order.paymentMethod === 'stripe' && typeof order.paymentIntentId === 'string' && order.paymentIntentId.startsWith('pi_')) {
            let intent;
            try {
                intent = await stripe.paymentIntents.retrieve(order.paymentIntentId);
            } catch (err) {
                console.error('Stripe retrieve (switch) error:', err.message);
                return res.status(502).json({ message: 'Could not check the card payment status, so the payment method was not changed. Please try again.' });
            }

            if (intent.status === 'succeeded') {
                return res.status(409).json({ message: 'Your card payment for this order has already gone through and is being confirmed, so the payment method can\'t be changed. Please do not pay again.' });
            }
            if (intent.status !== 'canceled') {
                if (!STRIPE_CANCELLABLE.includes(intent.status)) {
                    return res.status(409).json({ message: 'Your card payment is being processed right now, so the payment method can\'t be changed yet. Please wait a moment and check your order.' });
                }
                try {
                    await stripe.paymentIntents.cancel(order.paymentIntentId);
                } catch (err) {
                    // most likely it succeeded/started processing in the meantime
                    console.error('Stripe cancel (switch) error:', err.message);
                    return res.status(409).json({ message: 'The card payment could not be safely cancelled, so the payment method was not changed. Please check your order and try again.' });
                }
            }
        }

        // ---- one conditional update: only if nothing changed since we looked ----
        const update = {
            $set: { paymentMethod: target, paymentSwitchedAt: new Date() },
            $inc: { paymentSwitchCount: 1 },
            $unset: { gatewayPayment: '', paymentIntentId: '' }, // stale quote / provider reference of the OLD method
        };
        const g = order.gatewayPayment;
        if (g && g.provider && order.paymentIntentId && order.paymentMethod !== 'stripe') {
            update.$push = {
                abandonedGatewayAttempts: { provider: g.provider, reference: order.paymentIntentId, amountMinor: g.amountMinor, currency: g.currency, abandonedAt: new Date() },
            };
        }

        const updated = await Order.findOneAndUpdate(
            {
                _id: order._id,
                status: 'pending',
                paymentMethod: order.paymentMethod,
                paymentIntentId: order.paymentIntentId === undefined ? null : order.paymentIntentId,
            },
            update,
            { new: true }
        );
        if (!updated) {
            return res.status(409).json({ message: 'This order was just updated. Please refresh and try again.' });
        }

        res.json({ order: switchedOrderView(updated), switched: true });

        // A card/wallet order only gets its "order placed" email once payment is confirmed; cash-on-delivery
        // is confirmed immediately, so switching TO it sends that email now (once - a no-op switch returns above).
        if (target === 'cod') {
            sendOrderPlacedEmail(updated).catch((err) => console.error('Order placed email error:', err));
        }
    } catch (err) {
        console.error('Switch payment method error:', err);
        res.status(500).json({ message: 'Could not change the payment method.' });
    }
});

/* ============================================================
   Stripe (card payments)
   ============================================================ */

/** Checks a PaymentIntent really belongs to this order and covers its full amount. */
function stripeIntentMatchesOrder(paymentIntent, order) {
    return (
        order.paymentMethod === 'stripe' &&
        paymentIntent.id === order.paymentIntentId &&
        paymentIntent.amount === toCents(order.total) &&
        paymentIntent.currency === String(order.currency || STORE_CURRENCY).toLowerCase() &&
        paymentIntent.metadata &&
        paymentIntent.metadata.orderId === String(order._id)
    );
}

// POST /api/payments/stripe/create-intent  - body: { orderId }
// The amount is always read from the DB. Calling this again for the same order
// (double click, retry after a declined card) REUSES the open PaymentIntent
// instead of creating another one, and creation uses an idempotency key so a
// network retry can never create two.
router.post('/stripe/create-intent', optionalAuth, requireOrderAccess, async (req, res) => {
    try {
        const order = req.order;
        const problem = assertPayable(order, 'stripe');
        if (problem) return res.status(409).json({ message: problem });

        const amount = toCents(order.total);
        let staleIntentId = '';

        if (order.paymentIntentId && order.paymentIntentId.startsWith('pi_')) {
            const existing = await stripe.paymentIntents.retrieve(order.paymentIntentId);

            if (existing.status === 'succeeded') {
                return res.status(409).json({ message: 'This order has already been paid.' });
            }
            const reusable = ['requires_payment_method', 'requires_confirmation', 'requires_action'];
            if (reusable.includes(existing.status) && existing.amount === amount) {
                return res.json({ clientSecret: existing.client_secret });
            }
            staleIntentId = existing.id; // canceled / processing / wrong amount -> make a fresh one
        }

        const paymentIntent = await stripe.paymentIntents.create(
            {
                amount,
                currency: STRIPE_CURRENCY,
                metadata: { orderId: String(order._id) },
                automatic_payment_methods: { enabled: true },
            },
            // `s<n>` = how many times the payment method was switched: after Stripe -> other -> Stripe the key
            // changes, otherwise Stripe would replay the already-CANCELLED intent for the old key
            { idempotencyKey: `shopinza-intent-${order._id}-${amount}-s${order.paymentSwitchCount || 0}${staleIntentId ? `-after-${staleIntentId}` : ''}` }
        );

        await Order.updateOne({ _id: order._id, status: 'pending' }, { $set: { paymentIntentId: paymentIntent.id } });

        res.json({ clientSecret: paymentIntent.client_secret });
    } catch (err) {
        console.error('Stripe create-intent error:', err);
        res.status(500).json({ message: 'Could not start the card payment. Please try again.' });
    }
});

// POST /api/payments/stripe/confirm/:orderId  - fallback for local development,
// where Stripe's webhook can't reach localhost. After Stripe.js confirms the
// card client-side, the frontend calls this so the SERVER independently
// re-checks the PaymentIntent with Stripe (never trusts the client's word for
// it) - status, amount, currency and that it belongs to THIS order - before
// marking the order paid.
router.post('/stripe/confirm/:orderId', optionalAuth, requireOrderAccess, async (req, res) => {
    try {
        const order = req.order;
        if (order.paymentMethod !== 'stripe' || !order.paymentIntentId) {
            return res.status(400).json({ message: 'No card payment was started for this order.' });
        }

        const paymentIntent = await stripe.paymentIntents.retrieve(order.paymentIntentId);

        if (paymentIntent.status !== 'succeeded') {
            return res.status(402).json({ message: `Payment not completed yet (status: ${paymentIntent.status}).` });
        }
        if (!stripeIntentMatchesOrder(paymentIntent, order)) {
            console.error(`Stripe confirm: PaymentIntent ${paymentIntent.id} does not match order ${order._id}`);
            return res.status(400).json({ message: 'This payment does not match the order.' });
        }

        const result = await markOrderPaid(order._id, { paymentMethod: 'stripe', transactionId: paymentIntent.id });
        if (result && result.lateAfterCancel) {
            return res.status(409).json({ message: 'This order was cancelled before your payment arrived. We will refund you.' });
        }

        res.json({ order: result && result.order });
    } catch (err) {
        console.error('Stripe confirm error:', err);
        res.status(500).json({ message: 'Could not confirm payment status.' });
    }
});

// POST /api/payments/stripe/webhook  - Stripe calls this directly (production only;
// it needs a public HTTPS URL, so it won't reach a localhost dev server).
// NOTE: server.js mounts express.raw() for this exact path BEFORE express.json(),
// so req.body here is the raw Buffer that Stripe's signature check requires.
router.post('/stripe/webhook', async (req, res) => {
    const signature = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Stripe webhook signature verification failed:', err.message);
        return res.status(400).json({ message: 'Webhook signature verification failed.' });
    }

    if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const orderId = paymentIntent.metadata && paymentIntent.metadata.orderId;

        if (orderId && isValidObjectId(orderId)) {
            try {
                const order = await Order.findById(orderId);
                if (order && stripeIntentMatchesOrder(paymentIntent, order)) {
                    await markOrderPaid(order._id, { paymentMethod: 'stripe', transactionId: paymentIntent.id });
                } else {
                    console.error(`Stripe webhook: PaymentIntent ${paymentIntent.id} does not match order ${orderId} - ignored.`);
                }
            } catch (err) {
                // a real failure (e.g. DB down): answer 500 so Stripe RETRIES the event later.
                // Safe, because markOrderPaid is idempotent.
                console.error('Stripe webhook - could not mark order paid:', err);
                return res.status(500).json({ message: 'Temporary error, please retry.' });
            }
        }
    }

    res.json({ received: true });
});

/* ============================================================
   JazzCash (Page Redirect / Mobile Wallet API)
   Needs JAZZCASH_MERCHANT_ID / JAZZCASH_PASSWORD / JAZZCASH_INTEGRITY_SALT
   from your own JazzCash sandbox merchant account - this cannot be tested
   without them. Field names follow JazzCash's documented integration guide.
   ============================================================ */

// POST /api/payments/jazzcash/initiate  - body: { orderId }
router.post('/jazzcash/initiate', optionalAuth, requireOrderAccess, async (req, res) => {
    try {
        if (!process.env.JAZZCASH_MERCHANT_ID) {
            return res.status(503).json({
                message: 'JazzCash is not configured yet. Add JAZZCASH_* credentials to backend/.env.',
            });
        }

        const order = req.order;
        const problem = assertPayable(order, 'jazzcash');
        if (problem) return res.status(409).json({ message: problem });

        // PKR charge: the exact amount comes from the configured server-side rate, or we refuse
        const quote = quoteGatewayAmount(order, 'jazzcash');
        if (!quote.ok) return res.status(503).json({ code: quote.code, message: quote.message });
        const snapshot = quote.snapshot;

        const now = new Date();
        const expiry = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour to complete payment
        // unique per attempt, <= 20 chars (JazzCash limit); stored so the callback can prove it's OUR transaction
        const txnRefNo = `T${Date.now()}${crypto.randomInt(0, 1000)}`.slice(0, 20);

        const params = {
            pp_Version: '1.1',
            pp_TxnType: 'MWALLET',
            pp_Language: 'EN',
            pp_MerchantID: process.env.JAZZCASH_MERCHANT_ID,
            pp_Password: process.env.JAZZCASH_PASSWORD,
            pp_TxnRefNo: txnRefNo,
            pp_Amount: String(snapshot.amountMinor), // paisa, integer - the PKR quote, never the USD total
            pp_TxnCurrency: snapshot.currency,
            pp_TxnDateTime: formatGatewayDateTime(now),
            // this is the field we read back in the callback to identify the order -
            // it's sent verbatim by JazzCash, unlike pp_TxnRefNo which has a length limit
            pp_BillReference: String(order._id),
            pp_Description: `Shopinza order ${order._id}`,
            pp_TxnExpiryDateTime: formatGatewayDateTime(expiry),
            pp_ReturnURL:
                process.env.JAZZCASH_RETURN_URL ||
                `${req.protocol}://${req.get('host')}/api/payments/jazzcash/callback`,
        };

        const secureHash = generateSecureHash(params, process.env.JAZZCASH_INTEGRITY_SALT);

        await Order.updateOne(
            { _id: order._id, status: 'pending' },
            withArchivedAttempt(order, { $set: { paymentIntentId: txnRefNo, gatewayPayment: snapshot } })
        );

        res.json({
            actionUrl:
                process.env.JAZZCASH_SANDBOX_URL ||
                'https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/',
            fields: { ...params, pp_SecureHash: secureHash },
            display: gatewayDisplay(order, snapshot), // the checkout page must show this and get a click BEFORE redirecting
        });
    } catch (err) {
        console.error('JazzCash initiate error:', err);
        res.status(500).json({ message: 'Could not start JazzCash payment.' });
    }
});

function confirmationRedirect(res, orderId, status) {
    const id = orderId && isValidObjectId(String(orderId)) ? String(orderId) : '';
    return res.redirect(`${FRONTEND_URL}/order-confirmation.html?orderId=${id}&status=${status}`);
}

// POST /api/payments/jazzcash/callback  - JazzCash redirects the customer's browser
// here (as a form POST) after they complete or cancel payment on their page.
// The order is only marked paid after the secure hash, order reference, OUR
// transaction reference, the amount and the success code all check out.
router.post('/jazzcash/callback', express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const orderId = req.body && req.body.pp_BillReference;
        const order = orderId && isValidObjectId(String(orderId)) ? await Order.findById(orderId) : null;

        const verdict = verifyJazzCashCallback(req.body, order, process.env.JAZZCASH_INTEGRITY_SALT);

        if (!verdict.ok) {
            if (verdict.stale) {
                if (verdict.succeeded) await flagStaleGatewayPayment(order, 'JazzCash', req.body.pp_TxnRefNo);
                return confirmationRedirect(res, orderId, verdict.succeeded ? 'superseded' : 'failed');
            }
            if (!verdict.declined) {
                console.error(`JazzCash callback rejected (${verdict.reason}) for order ${orderId || '?'} - possible tampering, or bad Integrity Salt.`);
            }
            return confirmationRedirect(res, orderId, 'failed');
        }

        const result = await markOrderPaid(order._id, { paymentMethod: 'jazzcash', transactionId: verdict.transactionId });
        // money arrived for an order that was already cancelled: NOT a success - tell the customer the truth
        return confirmationRedirect(res, order._id, result && result.lateAfterCancel ? 'late' : 'success');
    } catch (err) {
        console.error('JazzCash callback error:', err);
        res.redirect(`${FRONTEND_URL}/order-confirmation.html?status=failed`);
    }
});

/* ============================================================
   Easypaisa (hosted checkout - same HMAC signature idea as JazzCash)
   Needs EASYPAISA_STORE_ID / EASYPAISA_HASH_KEY from your Easypaisa merchant
   portal. Field names below follow Easypaisa's commonly documented hosted
   checkout format - confirm them against the exact docs you receive during
   merchant onboarding, since this has not been tested against a live endpoint.
   ============================================================ */

// POST /api/payments/easypaisa/initiate  - body: { orderId }
router.post('/easypaisa/initiate', optionalAuth, requireOrderAccess, async (req, res) => {
    try {
        if (!process.env.EASYPAISA_STORE_ID) {
            return res.status(503).json({
                message: 'Easypaisa is not configured yet. Add EASYPAISA_* credentials to backend/.env.',
            });
        }

        const order = req.order;
        const problem = assertPayable(order, 'easypaisa');
        if (problem) return res.status(409).json({ message: problem });

        const quote = quoteGatewayAmount(order, 'easypaisa');
        if (!quote.ok) return res.status(503).json({ code: quote.code, message: quote.message });
        const snapshot = quote.snapshot;

        // the Mongo _id is already globally unique, so it doubles as the order
        // reference with no truncation/parsing needed on the way back in the callback
        const orderRefNum = String(order._id);

        const params = {
            storeId: process.env.EASYPAISA_STORE_ID,
            amount: (snapshot.amountMinor / 100).toFixed(2), // PKR quote, never the USD total
            postBackURL:
                process.env.EASYPAISA_RETURN_URL ||
                `${req.protocol}://${req.get('host')}/api/payments/easypaisa/callback`,
            orderRefNum,
            expiryDate: formatGatewayDateTime(new Date(Date.now() + 60 * 60 * 1000)),
            autoRedirect: '1',
            paymentMethod: 'MA_PAYMENT_METHOD',
        };

        const secureHash = generateSecureHash(params, process.env.EASYPAISA_HASH_KEY);

        await Order.updateOne(
            { _id: order._id, status: 'pending' },
            withArchivedAttempt(order, { $set: { paymentIntentId: orderRefNum, gatewayPayment: snapshot } })
        );

        res.json({
            actionUrl: process.env.EASYPAISA_SANDBOX_URL || 'https://easypaystg.easypaisa.com.pk/easypay/Index.jsf',
            fields: { ...params, merchantHashedReq: secureHash },
            display: gatewayDisplay(order, snapshot),
        });
    } catch (err) {
        console.error('Easypaisa initiate error:', err);
        res.status(500).json({ message: 'Could not start Easypaisa payment.' });
    }
});

// POST /api/payments/easypaisa/callback  - Easypaisa redirects back here after payment.
// FAILS CLOSED: the browser redirect alone is never proof of payment. The order is
// marked paid only if the callback is signed with our hash key AND its order
// reference, amount and success status match (utils/gatewayVerify.js). An
// unverifiable callback leaves the order "pending" and the customer sees a
// "we're confirming your payment" page - an admin can reconcile it manually.
router.post('/easypaisa/callback', express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const orderId = req.body && req.body.orderRefNum;
        const order = orderId && isValidObjectId(String(orderId)) ? await Order.findById(orderId) : null;

        const verdict = verifyEasypaisaCallback(req.body, order, process.env.EASYPAISA_HASH_KEY);

        if (!verdict.ok) {
            if (verdict.stale) {
                if (verdict.succeeded) await flagStaleGatewayPayment(order, 'Easypaisa', req.body.transactionId);
                return confirmationRedirect(res, orderId, verdict.succeeded ? 'superseded' : 'failed');
            }
            if (verdict.declined) return confirmationRedirect(res, orderId, 'failed');
            console.error(`Easypaisa callback NOT verified (${verdict.reason}) for order ${orderId || '?'} - left pending.`);
            return confirmationRedirect(res, orderId, 'pending');
        }

        const result = await markOrderPaid(order._id, { paymentMethod: 'easypaisa', transactionId: verdict.transactionId });
        return confirmationRedirect(res, order._id, result && result.lateAfterCancel ? 'late' : 'success');
    } catch (err) {
        console.error('Easypaisa callback error:', err);
        res.redirect(`${FRONTEND_URL}/order-confirmation.html?status=failed`);
    }
});

module.exports = router;
module.exports.markOrderPaid = markOrderPaid; // exported for tests
