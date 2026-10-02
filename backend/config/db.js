const mongoose = require('mongoose');

/**
 * Connects to MongoDB and REUSES the connection.
 *
 * Why it's cached: on Vercel the same warm function instance handles many
 * requests, and a cold start can run this from several requests at once.
 * Without caching every request would open a new connection and quickly
 * exhaust the Atlas connection limit. The cache lives on `global` so it also
 * survives module reloads inside one instance.
 *
 * This function THROWS on failure instead of calling process.exit(): killing
 * the process would take down every in-flight request on a shared production
 * instance. The caller decides what to do (server.js exits only in local
 * development; the request middleware answers 503 on Vercel).
 */
const cache = global.__shopinzaMongo || (global.__shopinzaMongo = { promise: null });

async function connectDB() {
    const uri = process.env.MONGO_URI;

    if (!uri) {
        throw new Error('MONGO_URI is not set. Copy .env.example to .env and fill it in.');
    }

    // already connected (readyState 1) - nothing to do
    if (mongoose.connection.readyState === 1) return mongoose;

    if (!cache.promise) {
        cache.promise = mongoose
            .connect(uri, { serverSelectionTimeoutMS: 10000 })
            .then((m) => {
                console.log('MongoDB connected');
                return m;
            })
            .catch((err) => {
                // clear the cache so the NEXT request can retry instead of
                // being stuck with a permanently rejected promise
                cache.promise = null;
                throw err;
            });
    }

    await cache.promise;
    return mongoose;
}

module.exports = connectDB;
