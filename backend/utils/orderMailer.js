const { sendMail } = require('./mailer');
const { escapeHtml } = require('./validate');
const { createTrackingToken } = require('./orderTracking');
const { formatMinor } = require('../config/currency');

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://127.0.0.1:5501').replace(/\/$/, '');

const STATUS_COPY = {
    shipped: {
        subject: 'Your Shopinza order has shipped',
        heading: 'Your order is on its way!',
        body: "Good news - your order has shipped and is headed your way.",
    },
    delivered: {
        subject: 'Your Shopinza order has been delivered',
        heading: 'Delivered!',
        body: 'Your order has been marked as delivered. We hope you love it.',
    },
};

/**
 * Cancellation email: states ONLY what actually happened. A refund is mentioned only when one was
 * really initiated (Stripe) or recorded as done by our team (JazzCash/Easypaisa); an order that was
 * cancelled before any payment says so; anything unclear tells the customer to contact support.
 */
function cancelledCopy(order) {
    const base = { subject: 'Your Shopinza order has been cancelled', heading: 'Order cancelled' };
    const amount = formatMoney(order.total);

    if (order.refundStatus === 'succeeded') {
        return { ...base, body: `Your order has been cancelled and we've refunded ${amount} to your original payment method. Depending on your bank, it can take 5-10 business days to appear.` };
    }
    if (order.refundStatus === 'pending') {
        return { ...base, body: `Your order has been cancelled and we've started a refund of ${amount} to your original payment method. It is still being processed - depending on your bank it can take 5-10 business days to appear.` };
    }
    if (order.refundStatus === 'manual_done') {
        return { ...base, body: 'Your order has been cancelled and our team has issued your refund directly. If it has not reached you within 5-10 business days, please contact support.' };
    }
    if (order.paidAt) {
        // paid (e.g. cash collected by hand) but no refund recorded - don't promise one
        return { ...base, body: 'Your order has been cancelled. If you have already paid for it, please contact support to arrange the return of your payment.' };
    }
    return { ...base, body: 'Your order has been cancelled. No payment had been received for this order when it was cancelled, so nothing was charged.' };
}

function formatMoney(amount) {
    return `$${Number(amount).toFixed(2)}`;
}

function buildItemsHtml(order) {
    return order.items
        .map(
            (item) =>
                `<tr>
                    <td style="padding:6px 0;">${escapeHtml(item.name)} &times; ${Number(item.qty)}</td>
                    <td style="padding:6px 0; text-align:right;">${formatMoney(item.price * item.qty)}</td>
                </tr>`
        )
        .join('');
}

/**
 * "Track your order" link. The signed token sits in the URL FRAGMENT (#track=...): browsers never send
 * it to servers or in Referer headers, and the page strips it from the address bar immediately.
 * It works from any browser/device, is read-only, expires, and is never logged or stored.
 * (No ORDER_TRACKING_SECRET in production => no token, the link just opens the page.)
 */
function buildTrackingLink(order) {
    const token = createTrackingToken(order._id);
    return `${FRONTEND_URL}/order-confirmation.html?orderId=${order._id}${token ? `#track=${token}` : ''}`;
}

function buildOrderSummaryHtml(order) {
    const trackingLink = buildTrackingLink(order);
    const s = order.shipping;

    return `
        <table style="width:100%; border-collapse:collapse; margin:16px 0;">
            ${buildItemsHtml(order)}
            <tr><td colspan="2"><hr /></td></tr>
            <tr><td>Subtotal</td><td style="text-align:right;">${formatMoney(order.subtotal)}</td></tr>
            <tr><td>Shipping</td><td style="text-align:right;">${order.shippingCost === 0 ? 'Free' : formatMoney(order.shippingCost)}</td></tr>
            <tr><td><strong>Total</strong></td><td style="text-align:right;"><strong>${formatMoney(order.total)}</strong></td></tr>
        </table>
        <p><strong>Shipping to:</strong><br/>
        ${escapeHtml(s.firstName)} ${escapeHtml(s.lastName)}<br/>
        ${escapeHtml(s.address)}<br/>
        ${escapeHtml(s.city)}, ${escapeHtml(s.state)} ${escapeHtml(s.zip)}</p>
        <p><a href="${trackingLink}">Track your order</a></p>
        <p style="color:#888; font-size:13px;">Order #${String(order._id).slice(-6).toUpperCase()}</p>
    `;
}

/** Cash-on-delivery orders: sent right after checkout, since there's no online payment step to wait for. */
async function sendOrderPlacedEmail(order) {
    if (!order.shipping || !order.shipping.email) return; // legacy order placed before the email field existed - nothing to send to

    await sendMail({
        to: order.shipping.email,
        subject: 'Your Shopinza order has been placed',
        html: `
            <p>Hi ${escapeHtml(order.shipping.firstName)},</p>
            <p>Thanks for your order! We've received it and it's being prepared. You'll pay ${formatMoney(order.total)} on delivery.</p>
            ${buildOrderSummaryHtml(order)}
        `,
    });
}

function paidAmountText(order) {
    const g = order.gatewayPayment;
    if (g && g.currency && g.amountMinor && g.currency !== (order.currency || 'USD')) {
        return `${formatMinor(g.amountMinor, g.currency)} (your order total is ${formatMoney(order.total)})`;
    }
    return formatMoney(order.total);
}

/** Online-payment orders (Stripe/JazzCash/Easypaisa): sent once the gateway confirms the charge. */
async function sendOrderPaidEmail(order) {
    if (!order.shipping || !order.shipping.email) return;

    await sendMail({
        to: order.shipping.email,
        subject: 'Payment received - your Shopinza order is confirmed',
        html: `
            <p>Hi ${escapeHtml(order.shipping.firstName)},</p>
            <p>We've received your payment of ${paidAmountText(order)} and your order is confirmed.</p>
            ${buildOrderSummaryHtml(order)}
        `,
    });
}

/** Order status changes (shipped / delivered / cancelled), sent from the admin dashboard. */
async function sendOrderStatusEmail(order) {
    if (!order.shipping || !order.shipping.email) return;

    const copy = order.status === 'cancelled' ? cancelledCopy(order) : STATUS_COPY[order.status];
    if (!copy) return; // no email template for this status (e.g. "pending"/"paid" are handled elsewhere)

    await sendMail({
        to: order.shipping.email,
        subject: copy.subject,
        html: `
            <p>Hi ${escapeHtml(order.shipping.firstName)},</p>
            <p><strong>${copy.heading}</strong></p>
            <p>${copy.body}</p>
            ${buildOrderSummaryHtml(order)}
        `,
    });
}

module.exports = { sendOrderPlacedEmail, sendOrderPaidEmail, sendOrderStatusEmail, cancelledCopy, buildTrackingLink };
