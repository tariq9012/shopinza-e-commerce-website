/* ==========================================================
   Shopinza - config.js
   Shared configuration for talking to the backend API.
   Change API_BASE_URL once you deploy the backend somewhere
   (Railway, Render, etc). Must be loaded before any other
   script that calls Api.*
   ========================================================== */

const API_BASE_URL = 'http://localhost:5000/api';

const Api = {
    TOKEN_KEY: 'shopinza_token',

    getToken() {
        return localStorage.getItem(this.TOKEN_KEY);
    },

    setToken(token) {
        localStorage.setItem(this.TOKEN_KEY, token);
    },

    clearToken() {
        localStorage.removeItem(this.TOKEN_KEY);
    },

    isLoggedIn() {
        return !!this.getToken();
    },

    /**
     * Wrapper around fetch() that prefixes the API base URL, sends JSON,
     * attaches the auth token when present, and normalizes error handling.
     */
    async request(path, { method = 'GET', body, auth = false } = {}) {
        const headers = { 'Content-Type': 'application/json' };

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
            const err = new Error(data.message || `Request failed (${response.status})`);
            err.status = response.status;
            err.data = data;
            throw err;
        }

        return data;
    },

    get(path, opts) {
        return this.request(path, { ...opts, method: 'GET' });
    },
    post(path, body, opts) {
        return this.request(path, { ...opts, method: 'POST', body });
    },
};
