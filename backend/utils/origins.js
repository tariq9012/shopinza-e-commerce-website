/**
 * Which browser Origins may call the API / open a WebSocket.
 *
 * Production (Vercel or NODE_ENV=production): the site and the API share ONE origin,
 * so only that same origin (plus anything listed in CLIENT_ORIGIN) is allowed -
 * an empty CLIENT_ORIGIN no longer means "allow everyone".
 * Local development keeps the old permissive behaviour when CLIENT_ORIGIN is empty,
 * because the frontend is usually opened from Live Server on another port.
 */
function configuredOrigins() {
    return (process.env.CLIENT_ORIGIN || '')
        .split(',')
        .map((origin) => origin.trim().replace(/\/$/, ''))
        .filter(Boolean);
}

function isProduction() {
    return Boolean(process.env.VERCEL) || process.env.NODE_ENV === 'production';
}

/**
 * @param origin  the request's Origin header (undefined for same-origin GETs, curl, server-to-server)
 * @param headers optional request headers, used to recognise "same origin" (Origin host === Host)
 */
function isAllowedOrigin(origin, headers = {}) {
    if (!origin) return true; // not a cross-origin browser request (curl, Stripe webhook, same-origin GET)

    const allowed = configuredOrigins();
    if (allowed.includes(origin.replace(/\/$/, ''))) return true;

    const host = headers['x-forwarded-host'] || headers.host;
    if (host) {
        try {
            if (new URL(origin).host === String(host).split(',')[0].trim()) return true;
        } catch (_err) {
            return false;
        }
    }

    // local development with nothing configured: allow (Live Server on another port etc.)
    if (allowed.length === 0 && !isProduction()) return true;

    return false;
}

module.exports = { isAllowedOrigin, configuredOrigins, isProduction };
