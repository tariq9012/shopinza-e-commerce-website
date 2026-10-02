/* ==========================================================
   Shopinza - config.js
   Shared configuration for talking to the backend API.
   API_BASE_URL is same-origin (/api) when deployed on Vercel, so
   nothing needs editing per environment. Must be loaded before any other
   script that calls Api.*
   ========================================================== */

// Where the backend lives:
//  - Deployed on Vercel (frontend + backend are ONE project / ONE domain), and
//    also under `vercel dev`: same origin as the page, so no URL is hard-coded
//    and preview deployments / custom domains just work.
//  - Old local setup (page opened from VS Code Live Server on :5501, or as a
//    file://, with `npm run dev` running the API on :5000): talk to localhost:5000.
const LOCAL_BACKEND_ORIGIN = 'http://localhost:5000';
const IS_SEPARATE_LOCAL_FRONTEND =
    window.location.protocol === 'file:' ||
    (['localhost', '127.0.0.1'].includes(window.location.hostname) &&
        !['3000', '5000'].includes(window.location.port));
const BACKEND_ORIGIN = IS_SEPARATE_LOCAL_FRONTEND ? LOCAL_BACKEND_ORIGIN : window.location.origin;

const API_BASE_URL = `${BACKEND_ORIGIN}/api`;

// Socket.io connects to the server root, not the /api path - same origin as
// the API, since it rides on the same backend (see backend/socket.js).
const SOCKET_URL = BACKEND_ORIGIN;

// Google Sign-In: create an OAuth 2.0 Client ID at
// https://console.cloud.google.com/apis/credentials ("Web application" type),
// add your frontend's URL (e.g. http://127.0.0.1:5501) under
// "Authorized JavaScript origins", then paste the Client ID below.
// Google Sign-In stays hidden on the login page until this is set.
let GOOGLE_CLIENT_ID = ''; // leave empty on Vercel: filled in at runtime from the API (GOOGLE_CLIENT_ID env variable) - see Api.loadPublicConfig()

// Facebook Login: create an app at https://developers.facebook.com/apps,
// add the "Facebook Login" product, and under Settings > Basic add your
// frontend's URL (e.g. http://127.0.0.1:5501) to "App Domains" plus a
// matching entry under Facebook Login > Settings > "Valid OAuth Redirect
// URIs". Paste the App ID below (find it on the app's Settings > Basic
// page). Facebook Login stays hidden on the login page until this is set.
let FACEBOOK_APP_ID = ''; // same: filled in at runtime from the API (FACEBOOK_APP_ID env variable)

const Api = {
    TOKEN_KEY: 'shopinza_token',
    REFRESH_TOKEN_KEY: 'shopinza_refresh_token',
    USER_NAME_KEY: 'shopinza_user_name',

    getToken() {
        return localStorage.getItem(this.TOKEN_KEY);
    },

    getRefreshToken() {
        return localStorage.getItem(this.REFRESH_TOKEN_KEY);
    },

    /**
     * Saves the access token (short-lived, ~15 min) and, when provided, the
     * refresh token (long-lived, ~30 days) used to silently obtain new
     * access tokens without forcing the user to log in again.
     */
    setToken(token, refreshToken) {
        localStorage.setItem(this.TOKEN_KEY, token);
        if (refreshToken) localStorage.setItem(this.REFRESH_TOKEN_KEY, refreshToken);
    },

    /** Remembers the signed-in customer's first name, so the navbar can show
     * it (see main.js) without an extra API call on every page load. */
    setUserName(name) {
        if (name) localStorage.setItem(this.USER_NAME_KEY, name);
    },

    getUserName() {
        return localStorage.getItem(this.USER_NAME_KEY);
    },

    clearToken() {
        localStorage.removeItem(this.TOKEN_KEY);
        localStorage.removeItem(this.REFRESH_TOKEN_KEY);
        localStorage.removeItem(this.USER_NAME_KEY);
    },

    isLoggedIn() {
        return !!this.getToken();
    },

    /**
     * Silently exchanges the refresh token for a new access token. Used
     * internally by request()/upload() when an access token has expired.
     * Returns true on success, false if the refresh token is missing/invalid
     * (in which case the user needs to log in again).
     */
    async _refreshAccessToken() {
        const refreshToken = this.getRefreshToken();
        if (!refreshToken) return false;

        try {
            const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken }),
            });

            if (!response.ok) {
                this.clearToken();
                return false;
            }

            const data = await response.json();
            this.setToken(data.token, data.refreshToken);
            return true;
        } catch (err) {
            return false;
        }
    },

    /**
     * Wrapper around fetch() that prefixes the API base URL, sends JSON,
     * attaches the auth token when present, and normalizes error handling.
     * On a 401 caused by an expired access token, it silently refreshes and
     * retries the request once before giving up.
     */
    async request(path, { method = 'GET', body, auth = false, headers: extraHeaders } = {}, _isRetry = false) {
        const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };

        if (auth) {
            const token = this.getToken();
            if (token) headers.Authorization = `Bearer ${token}`;
        }

        let response;
        try {
            response = await fetch(`${API_BASE_URL}${path}`, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
            });
        } catch (networkErr) {
            // the backend server is not running / not reachable
            const err = new Error(
                'Could not reach the Shopinza server. Make sure the backend is running.'
            );
            err.isNetworkError = true;
            throw err;
        }

        let data = {};
        try {
            data = await response.json();
        } catch (parseErr) {
            // no JSON body (e.g. plain 500 page) - keep data as {}
        }

        if (!response.ok) {
            // access token expired mid-session - refresh once and retry,
            // instead of kicking the user back to the login page
            if (response.status === 401 && auth && data.expired && !_isRetry && this.getRefreshToken()) {
                const refreshed = await this._refreshAccessToken();
                if (refreshed) {
                    return this.request(path, { method, body, auth, headers: extraHeaders }, true);
                }
            }

            const err = new Error(data.message || `Request failed (${response.status})`);
            err.status = response.status;
            err.data = data;
            throw err;
        }

        return data;
    },

    /**
     * Fetches the PUBLIC social-login identifiers from the API once, so they can be
     * set as Vercel environment variables instead of being hard-coded in this file.
     * A value already hard-coded above still wins. Never throws.
     */
    loadPublicConfig() {
        if (!this._publicConfigPromise) {
            this._publicConfigPromise = fetch(`${API_BASE_URL}/auth/public-config`)
                .then((response) => (response.ok ? response.json() : {}))
                .then((cfg) => {
                    if (!GOOGLE_CLIENT_ID && cfg.googleClientId) GOOGLE_CLIENT_ID = cfg.googleClientId;
                    if (!FACEBOOK_APP_ID && cfg.facebookAppId) FACEBOOK_APP_ID = cfg.facebookAppId;
                    return cfg;
                })
                .catch(() => ({}));
        }
        return this._publicConfigPromise;
    },

    /**
     * Uploads images STRAIGHT to Cloudinary (not through our server), because Vercel rejects
     * request bodies over ~4.5 MB. The server only hands out a short-lived signature.
     * scope: 'product' (admin) or 'review' (any signed-in customer).
     * Returns [{ url, publicId }] in the same shape the old /api/upload endpoints returned.
     */
    async uploadImagesDirect(files, scope) {
        const MAX_BYTES = 10 * 1024 * 1024; // Cloudinary's default per-image limit
        const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

        for (const file of files) {
            if (!ALLOWED.includes(file.type)) throw new Error('Only JPG, PNG, WEBP, or GIF images are allowed.');
            if (file.size > MAX_BYTES) throw new Error('Each image must be 10 MB or smaller.');
        }

        const sig = await this.post('/upload/sign', { scope }, { auth: true });

        const results = [];
        for (const file of files) {
            const form = new FormData();
            form.append('file', file);
            form.append('api_key', sig.apiKey);
            form.append('timestamp', sig.timestamp);
            form.append('folder', sig.folder);
            form.append('allowed_formats', sig.allowed_formats);
            form.append('signature', sig.signature);

            let response;
            try {
                response = await fetch(sig.uploadUrl, { method: 'POST', body: form });
            } catch (networkErr) {
                throw new Error('Could not reach the image service. Please try again.');
            }
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.secure_url) {
                throw new Error((data.error && data.error.message) || 'Image upload failed. Please try again.');
            }
            results.push({ url: data.secure_url, publicId: data.public_id });
        }
        return results;
    },

    get(path, opts) {
        return this.request(path, { ...opts, method: 'GET' });
    },
    post(path, body, opts) {
        return this.request(path, { ...opts, method: 'POST', body });
    },

    /**
     * Uploads a FormData payload (e.g. image files). Unlike request(), this
     * does NOT set Content-Type manually — the browser sets the correct
     * multipart/form-data boundary automatically. Always sends the auth token.
     */
    async upload(path, formData, _isRetry = false) {
        const headers = {};
        const token = this.getToken();
        if (token) headers.Authorization = `Bearer ${token}`;

        let response;
        try {
            response = await fetch(`${API_BASE_URL}${path}`, {
                method: 'POST',
                headers,
                body: formData,
            });
        } catch (networkErr) {
            const err = new Error('Could not reach the Shopinza server. Make sure the backend is running.');
            err.isNetworkError = true;
            throw err;
        }

        let data = {};
        try {
            data = await response.json();
        } catch (parseErr) {
            // no JSON body
        }

        if (!response.ok) {
            if (response.status === 401 && data.expired && !_isRetry && this.getRefreshToken()) {
                const refreshed = await this._refreshAccessToken();
                if (refreshed) {
                    return this.upload(path, formData, true);
                }
            }

            const err = new Error(data.message || `Upload failed (${response.status})`);
            err.status = response.status;
            err.data = data;
            throw err;
        }

        return data;
    },
};

/**
 * Order access tokens. A guest (not signed in) can only view/pay for the order they
 * just placed because the server gave THIS browser a secret token at checkout. We keep
 * it here (per order id) and send it as the X-Order-Token header. Signed-in owners
 * don't need it - their login token proves ownership.
 */
const OrderAccess = {
    KEY: 'shopinza_order_tokens',
    MAX_ENTRIES: 30,

    _read() {
        try {
            return JSON.parse(localStorage.getItem(this.KEY)) || {};
        } catch (err) {
            return {};
        }
    },

    set(orderId, token) {
        if (!orderId || !token) return;
        const map = this._read();
        map[orderId] = token;
        const ids = Object.keys(map);
        // keep only the most recent entries (object keys keep insertion order)
        ids.slice(0, Math.max(0, ids.length - this.MAX_ENTRIES)).forEach((id) => delete map[id]);
        try {
            localStorage.setItem(this.KEY, JSON.stringify(map));
        } catch (err) {
            // storage full / blocked - the order still works while this tab stays open
        }
    },

    get(orderId) {
        return this._read()[orderId] || null;
    },

    // Signed, read-only "Track your order" token from an EMAIL link (#track=...). Kept in MEMORY only -
    // never written to localStorage/sessionStorage - so it disappears when the tab closes.
    _tracking: {},

    /** Stores a tracking token (the order id is its first segment). Returns the order id, or null. */
    setTracking(token) {
        const orderId = String(token || '').split('.')[0];
        if (!/^[a-f0-9]{24}$/i.test(orderId)) return null;
        this._tracking[orderId] = token;
        return orderId;
    },

    getTracking(orderId) {
        return this._tracking[orderId] || null;
    },

    /** Headers to pass to Api.get/post for calls about one order. */
    headers(orderId) {
        const headers = {};
        const token = this.get(orderId);
        if (token) headers['X-Order-Token'] = token;
        const tracking = this.getTracking(orderId);
        if (tracking) headers['X-Order-Tracking-Token'] = tracking;
        return headers;
    },
};
