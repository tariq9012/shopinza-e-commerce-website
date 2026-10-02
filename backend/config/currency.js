const { toCents } = require('../utils/money');

/**
 * CURRENCY POLICY (single source of truth)
 *
 *  - The store is priced in ONE canonical currency: STORE_CURRENCY (USD). Every product
 *    price, order total, coupon and shipping cost is in it, and every order records it
 *    (`order.currency`).
 *  - Stripe charges in the store currency (USD) - no conversion.
 *  - JazzCash and Easypaisa charge in PKR. A USD amount is NEVER reused as a PKR amount.
 *    They work only when a deliberate server-side rate is configured (USD_TO_PKR_RATE);
 *    the exact PKR amount, currency and rate are snapshotted on the order (`gatewayPayment`)
 *    when the payment is started, and the gateway callback must match that snapshot.
 *    Without a rate they fail closed ("not configured for this currency").
 *  - No exchange rate is ever invented or hard-coded here.
 */
const STORE_CURRENCY = 'USD';

const GATEWAY_CURRENCY = {
    stripe: 'USD',
    jazzcash: 'PKR',
    easypaisa: 'PKR',
};

/** The configured USD->PKR rate as a positive finite number, or null when unset/invalid. */
function getUsdToPkrRate() {
    const raw = process.env.USD_TO_PKR_RATE;
    if (raw === undefined || String(raw).trim() === '') return null;
    const rate = Number(raw);
    return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** "PKR 13,999.00" - amount is in MINOR units (cents / paisa). */
function formatMinor(amountMinor, currency) {
    const value = (Math.round(amountMinor) / 100).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
    return `${currency} ${value}`;
}

/**
 * The exact amount the gateway must charge for this order, or a reason it can't be computed.
 * @returns {{ ok: true, snapshot } | { ok: false, code, message }}
 */
function quoteGatewayAmount(order, provider) {
    const currency = GATEWAY_CURRENCY[provider];
    if (!currency) return { ok: false, code: 'UNKNOWN_PROVIDER', message: 'Unknown payment method.' };

    const orderCurrency = order.currency || STORE_CURRENCY;
    const orderMinor = toCents(order.total);

    if (currency === orderCurrency) {
        return {
            ok: true,
            snapshot: { provider, currency, amountMinor: orderMinor, rate: 1, orderTotalMinor: orderMinor, orderCurrency, quotedAt: new Date() },
        };
    }

    if (orderCurrency === 'USD' && currency === 'PKR') {
        const rate = getUsdToPkrRate();
        if (!rate) {
            return {
                ok: false,
                code: 'CURRENCY_NOT_CONFIGURED',
                message: 'This payment method is not configured for this currency yet. Please choose another payment method.',
            };
        }
        return {
            ok: true,
            snapshot: {
                provider,
                currency,
                amountMinor: Math.round(orderMinor * rate), // USD cents x (PKR per USD) = PKR paisa
                rate,
                orderTotalMinor: orderMinor,
                orderCurrency,
                quotedAt: new Date(),
            },
        };
    }

    return { ok: false, code: 'CURRENCY_NOT_CONFIGURED', message: 'This payment method is not available for this order\'s currency.' };
}

module.exports = { STORE_CURRENCY, GATEWAY_CURRENCY, getUsdToPkrRate, formatMinor, quoteGatewayAmount };
