require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const connectDB = require('./config/db');
const { initSocket } = require('./socket');

const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const contactRoutes = require('./routes/contactRoutes');
const newsletterRoutes = require('./routes/newsletterRoutes');
const adminRoutes = require('./routes/adminRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const reviewRoutes = require('./routes/reviewRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const cartRoutes = require('./routes/cartRoutes');
const couponRoutes = require('./routes/couponRoutes');
const cronRoutes = require('./routes/cronRoutes');
const wishlistRoutes = require('./routes/wishlistRoutes');
const { cancelAbandonedOrders } = require('./jobs/cancelAbandonedOrders');
const { isAllowedOrigin } = require('./utils/origins');
const { apiLimiter, authLimiter, orderCreateLimiter, paymentLimiter, formLimiter } = require('./middleware/rateLimits');

const app = express();

// ---------- middleware ----------
// On Vercel the request passes exactly one trusted proxy; without this every
// client would look like the same IP to the rate limiter.
app.set('trust proxy', process.env.VERCEL ? 1 : false);

// Security headers (no X-Powered-By, nosniff, HSTS, ...). This is a JSON API, so
// the browser-side page policy lives on the static frontend (see vercel.json).
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// Strict CORS: in production only the site's own origin (and CLIENT_ORIGIN, if set)
// may call the API from a browser. Local development stays permissive when
// CLIENT_ORIGIN is empty (see utils/origins.js).
app.use(
    cors((req, callback) => {
        const origin = req.headers.origin;
        callback(null, { origin: isAllowedOrigin(origin, req.headers) ? true : false, credentials: true });
    })
);

// Stripe's webhook needs the raw, unparsed request body to verify its signature.
// This MUST be mounted before the global express.json() below, or the body
// arrives already parsed/re-serialized and signature verification will fail.
app.use('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '200kb' }));

// Make sure MongoDB is connected before any route runs. On Vercel there is no
// long-lived "startup" step, so each instance connects lazily on its first
// request (connectDB caches the connection, so later requests pay nothing).
app.use(async (_req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (err) {
        console.error('MongoDB connection failed:', err.message);
        res.status(503).json({ message: 'Database temporarily unavailable. Please try again.' });
    }
});

// ---------- routes ----------
app.get('/', (_req, res) => {
    res.json({ message: 'Shopinza API is running.' });
});

// ---------- rate limiting ----------
app.use('/api', (req, res, next) => {
    // Stripe (fixed IPs, retries) and Vercel Cron authenticate themselves - never throttle them
    if (req.path === '/payments/stripe/webhook' || req.path.startsWith('/cron/')) return next();
    return apiLimiter(req, res, next);
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/resend-verification', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/auth/google', authLimiter);
app.use('/api/auth/facebook', authLimiter);
app.post('/api/orders', orderCreateLimiter);
app.use('/api/payments/stripe/create-intent', paymentLimiter);
app.use('/api/payments/stripe/confirm', paymentLimiter);
app.use('/api/payments/switch-method', paymentLimiter);
app.use('/api/payments/jazzcash/initiate', paymentLimiter);
app.use('/api/payments/easypaisa/initiate', paymentLimiter);
app.post('/api/contact', formLimiter);
app.post('/api/newsletter', formLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/newsletter', newsletterRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/coupons', couponRoutes);
app.use('/api/wishlist', wishlistRoutes);
app.use('/api/cron', cronRoutes);

// ---------- 404 handler ----------
app.use((req, res) => {
    res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ---------- error handler ----------
app.use((err, _req, res, _next) => {
    // malformed JSON / oversized body etc. are the CLIENT's mistake (4xx), not a server crash
    const status = Number(err.status || err.statusCode);
    if (status >= 400 && status < 500) {
        return res.status(status).json({ message: status === 413 ? 'Request body is too large.' : 'Invalid request.' });
    }
    console.error(err);
    res.status(500).json({ message: 'Internal server error.' });
});

// ---------- start ----------
// Socket.io needs the raw http.Server (not just the Express app) so it can
// share the same port as the REST API instead of needing a separate one.
const server = http.createServer(app);
initSocket(server);

// Vercel captures the server.listen() call below and routes HTTP + WebSocket
// traffic to this server, so the same code path is used everywhere. The only
// differences on Vercel: MongoDB connects lazily per request (see the middleware
// above) and the cleanup timer is replaced by Vercel Cron.
const isVercel = Boolean(process.env.VERCEL);
const PORT = process.env.PORT || 5000;

if (!isVercel) {
    // Local development / normal Node hosting only
    connectDB()
        .then(() => {
            server.listen(PORT, () => {
                console.log(`Shopinza API listening on http://localhost:${PORT}`);
            });

            const CLEANUP_INTERVAL_MINUTES =
                Number(process.env.ORDER_CLEANUP_INTERVAL_MINUTES) || 10;

            setTimeout(
                () =>
                    cancelAbandonedOrders().catch((err) =>
                        console.error('Order cleanup job error:', err)
                    ),
                15000
            );

            setInterval(
                () =>
                    cancelAbandonedOrders().catch((err) =>
                        console.error('Order cleanup job error:', err)
                    ),
                CLEANUP_INTERVAL_MINUTES * 60 * 1000
            );
        })
        .catch((err) => {
            console.error('MongoDB connection failed:', err.message);
            process.exit(1);
        });
}

// Vercel uses the exported HTTP server.
// Socket.IO is already attached to this same server above.
module.exports = server;
