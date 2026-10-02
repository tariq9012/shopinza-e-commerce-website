const crypto = require('crypto');

/**
 * JazzCash's Page Redirection / Mobile Wallet API requires a `pp_SecureHash`
 * field computed like this:
 *   1. Take every pp_* parameter EXCEPT pp_SecureHash itself.
 *   2. Sort the parameter names alphabetically.
 *   3. Join their values (skipping empty ones) with '&'.
 *   4. Prepend the merchant's Integrity Salt, also joined with '&'.
 *   5. HMAC-SHA256 that string, using the Integrity Salt as the key.
 *
 * This mirrors the format documented in JazzCash's Payment Gateway
 * integration guide (the same pattern most Pakistani JazzCash integrations
 * use). Easypaisa's hosted-checkout API uses a similar HMAC-based signature,
 * so this helper is written generically enough to reuse for it too — see
 * routes/paymentRoutes.js.
 *
 * IMPORTANT: this can only be verified against JazzCash's real sandbox once
 * you have your own Merchant ID / Password / Integrity Salt from their
 * merchant portal — it has not been tested against a live JazzCash endpoint.
 */
function generateSecureHash(params, integritySalt) {
    const sortedKeys = Object.keys(params).sort();

    const valueString = sortedKeys
        .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== '')
        .map((key) => params[key])
        .join('&');

    const hashInput = `${integritySalt}&${valueString}`;
    return crypto.createHmac('sha256', integritySalt).update(hashInput).digest('hex');
}

module.exports = { generateSecureHash };
