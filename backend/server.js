require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('./config/db');

const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const contactRoutes = require('./routes/contactRoutes');
const newsletterRoutes = require('./routes/newsletterRoutes');

const app = express();

// ---------- middleware ----------
const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

app.use(
    cors({
        origin: function (origin, callback) {
            // allow requests with no origin (like Postman, curl, or opening the HTML file directly)
            if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            callback(new Error('Not allowed by CORS'));
        },
        credentials: true,
    })
);
app.use(express.json());

// ---------- routes ----------
app.get('/', (_req, res) => {
    res.json({ message: 'Shopinza API is running.' });
});

app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/newsletter', newsletterRoutes);

// ---------- 404 handler ----------
app.use((req, res) => {
    res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ---------- error handler ----------
app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ message: 'Internal server error.' });
});

// ---------- start ----------
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Shopinza API listening on http://localhost:${PORT}`);
    });
});
