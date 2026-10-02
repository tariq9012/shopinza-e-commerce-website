/**
 * In-memory stand-ins for the Mongoose models, so the REAL route code can be tested
 * without a MongoDB server. They implement only what the routes call.
 * Install them BEFORE requiring any route (see installFakes()).
 */
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const BACKEND = path.resolve(__dirname, '..', '..');
const newId = () => crypto.randomBytes(12).toString('hex');

function mod(rel, exports) {
    const file = require.resolve(path.join(BACKEND, rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
}

/** A query object that can be awaited, and also chained with select()/session()/lean(). */
function query(getResult) {
    const q = {
        select: () => q,
        session: () => q,
        lean: () => q,
        sort: () => q,
        then: (res, rej) => Promise.resolve().then(getResult).then(res, rej),
    };
    return q;
}

const matchValue = (actual, cond) => {
    if (cond === null) return actual === undefined || actual === null; // Mongo: null matches a missing field too
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        if ('$in' in cond) return cond.$in.includes(actual === undefined ? null : actual);
        if ('$gte' in cond) return actual >= cond.$gte;
        if ('$gt' in cond) return actual > cond.$gt;
        if ('$exists' in cond) return (actual !== undefined) === cond.$exists;
    }
    return String(actual) === String(cond);
};

/** applies the update operators the routes use: $set / $unset / $inc / $push */
function applyUpdate(doc, update) {
    Object.assign(doc, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete doc[key];
    for (const [key, value] of Object.entries(update.$inc || {})) doc[key] = (doc[key] || 0) + value;
    for (const [key, value] of Object.entries(update.$push || {})) (doc[key] = doc[key] || []).push(value);
}

/** every key of a Mongo-style filter must match the document (supports $in / $gte / $gt / $exists / null) */
function matches(doc, filter) {
    return Object.entries(filter).every(([key, cond]) => matchValue(doc[key], cond));
}

function makeDoc(data, store) {
    const doc = { ...data };
    Object.defineProperty(doc, 'toObject', { value: () => JSON.parse(JSON.stringify(doc)), enumerable: false });
    Object.defineProperty(doc, 'save', { value: async () => doc, enumerable: false });
    store.push(doc);
    return doc;
}

function createFakes() {
    const state = { products: [], orders: [], coupons: [], users: [], calls: { productInc: [], couponInc: [], emails: [], emits: [], stripeRetrieve: [] } };

    const Product = {
        find: (filter) => query(() => state.products.filter((p) => matchValue(p.slug, filter.slug))),
        findOne: (filter) => query(() => state.products.find((p) => p.slug === filter.slug) || null),
        findOneAndUpdate: async (filter, update, opts = {}) => {
            const p = state.products.find((x) => x.slug === filter.slug);
            if (!p) return null;
            const inc = update.$inc || {};
            if (filter.variants && filter.variants.$elemMatch) {
                const m = filter.variants.$elemMatch;
                const v = p.variants.find((x) => x.color === m.color && x.size === m.size && (!m.stock || x.stock >= m.stock.$gte));
                if (!v) return null;
                v.stock += inc['variants.$[v].stock'] || 0;
                p.stock += inc.stock || 0;
            } else {
                if (filter.stock && !(p.stock >= filter.stock.$gte)) return null;
                p.stock += inc.stock || 0;
            }
            state.calls.productInc.push({ slug: filter.slug, inc });
            return p;
        },
    };

    const Order = {
        create: async (docs) => docs.map((d) => makeDoc({ _id: newId(), status: 'pending', createdAt: new Date(), ...d }, state.orders)),
        find: (filter) => { state.calls.orderFindFilters = state.calls.orderFindFilters || []; state.calls.orderFindFilters.push(filter); return query(() => state.orders); },
        // a SNAPSHOT (like a real Mongoose query result): two requests that both read "pending" before either writes
        // both see "pending", which is exactly the race the atomic conditional updates must survive
        findById: (id) =>
            query(() => {
                const o = state.orders.find((x) => String(x._id) === String(id));
                if (!o) return null;
                const copy = { ...o };
                Object.defineProperty(copy, 'toObject', { value: () => JSON.parse(JSON.stringify(copy)), enumerable: false });
                Object.defineProperty(copy, 'save', { value: async () => copy, enumerable: false });
                return copy;
            }),
        updateOne: async (filter, update) => {
            const o = state.orders.find((x) => matches(x, filter));
            if (!o) return { modifiedCount: 0 };
            applyUpdate(o, update);
            return { modifiedCount: 1 };
        },
        findOneAndUpdate: async (filter, update) => {
            const o = state.orders.find((x) => matches(x, filter));
            if (!o) return null;
            applyUpdate(o, update);
            return o;
        },
    };

    const Coupon = {
        findOne: ({ code }) => query(() => state.coupons.find((c) => c.code === code) || null),
        findOneAndUpdate: async (filter, update) => {
            const c = state.coupons.find((x) => String(x._id) === String(filter._id));
            if (!c) return null;
            if (c.usageLimit != null && c.usedCount >= c.usageLimit) return null;
            c.usedCount += update.$inc.usedCount;
            state.calls.couponInc.push(update.$inc.usedCount);
            return c;
        },
        updateOne: async (filter, update) => {
            const c = state.coupons.find((x) => x.code === filter.code);
            if (c && c.usedCount > 0) { c.usedCount += update.$inc.usedCount; state.calls.couponInc.push(update.$inc.usedCount); }
        },
    };

    const User = {
        findById: (id) => query(() => state.users.find((u) => String(u._id) === String(id)) || null),
        findOne: () => query(() => null),
    };

    return { state, Product, Order, Coupon, User, makeDoc };
}

function installFakes({ stripe } = {}) {
    const fakes = createFakes();

    mod('models/Product.js', fakes.Product);
    mod('models/Order.js', fakes.Order);
    mod('models/Coupon.js', fakes.Coupon);
    mod('models/User.js', fakes.User);
    mod('config/db.js', async () => {});
    // cloudinary is never called for real in tests
    const cloudCalls = (fakes.state.calls.cloudinary = []);
    mod('config/cloudinary.js', {
        uploader: {
            upload_stream: (opts, cb) => ({
                end: (buf) => {
                    cloudCalls.push({ folder: opts.folder, bytes: buf.length });
                    cb(null, { secure_url: `https://res.cloudinary.com/demo/${opts.folder}/${cloudCalls.length}.png`, public_id: `p${cloudCalls.length}` });
                },
            }),
        },
        utils: { api_sign_request: (params, secret) => require('crypto').createHash('sha1').update(JSON.stringify(params) + secret).digest('hex') },
    });
    mod('config/stripe.js', stripe || { paymentIntents: {}, webhooks: require(path.join(BACKEND, 'node_modules/stripe'))('sk_test_dummy').webhooks });
    mod('utils/orderMailer.js', {
        sendOrderPlacedEmail: async (o) => fakes.state.calls.emails.push(['placed', String(o._id)]),
        sendOrderPaidEmail: async (o) => fakes.state.calls.emails.push(['paid', String(o._id)]),
        sendOrderStatusEmail: async (o) => fakes.state.calls.emails.push(['status', String(o._id), o.status, o.refundStatus]),
    });
    // keep the real socket module out of the way for route tests; record pushes instead
    mod('socket.js', { initSocket: () => {}, getIO: () => null, emitOrderUpdate: (o) => fakes.state.calls.emits.push([String(o._id), o.status]) });

    // mongoose transactions -> run the callback directly (the fakes have no real DB)
    const mongoose = require(path.join(BACKEND, 'node_modules/mongoose'));
    mongoose.startSession = async () => ({ withTransaction: async (fn) => fn(), endSession: () => {} });

    return fakes;
}

module.exports = { installFakes, newId, BACKEND };
