const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
    console.warn(
        '⚠️  STRIPE_SECRET_KEY is not set in .env — card payments will fail until it is added.'
    );
}

// Falls back to a placeholder so the server can still boot without Stripe configured
// (COD and other payment methods will keep working either way).
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder_not_configured');

module.exports = stripe;
