/** Small input-validation helpers shared by the routes (no extra dependency). */

/** true only for real strings (blocks objects like {"$gt": ""} sent as "email"). */
function isString(value, { min = 1, max = 500 } = {}) {
    return typeof value === 'string' && value.length >= min && value.length <= max;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:]+@[^\s@<>()[\]\\,;:]+\.[^\s@<>()[\]\\,;:]{2,}$/;

function isEmail(value) {
    return isString(value, { min: 5, max: 254 }) && EMAIL_RE.test(value.trim());
}

/** Escapes text before it is placed inside an HTML email. */
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const SHIPPING_FIELDS = {
    firstName: { required: true, max: 80 },
    lastName: { required: true, max: 80 },
    email: { required: true, max: 254 },
    address: { required: true, max: 250 },
    city: { required: true, max: 100 },
    state: { required: true, max: 100 },
    zip: { required: true, max: 20 },
    phone: { required: false, max: 30 },
};

/**
 * Whitelists and validates the shipping block. Returns { shipping } or { error }.
 * Unknown fields are dropped, so nothing else from the request can reach the DB.
 */
function cleanShipping(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { error: 'Please provide your shipping details.' };
    }

    const shipping = {};
    for (const [field, rule] of Object.entries(SHIPPING_FIELDS)) {
        const value = input[field];
        if (value === undefined || value === null || value === '') {
            if (rule.required) return { error: `Please provide your ${field}.` };
            continue;
        }
        if (!isString(value, { max: rule.max })) return { error: `Your ${field} is not valid.` };
        shipping[field] = value.trim();
        if (rule.required && !shipping[field]) return { error: `Please provide your ${field}.` };
    }

    if (!isEmail(shipping.email)) return { error: 'Please enter a valid email address.' };
    shipping.email = shipping.email.toLowerCase();

    return { shipping };
}

module.exports = { isString, isEmail, escapeHtml, cleanShipping };
