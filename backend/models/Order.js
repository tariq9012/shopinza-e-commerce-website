const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
    {
        productId: { type: String, required: true },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        image: { type: String },
        qty: { type: Number, required: true, min: 1 },
        // only present for products that have size/color variants
        color: { type: String },
        size: { type: String },
    },
    { _id: false }
);

const orderSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false },
        items: { type: [orderItemSchema], required: true },
        shipping: {
            firstName: { type: String, required: true },
            lastName: { type: String, required: true },
            email: { type: String }, // used to send order/status emails - required at checkout, but optional here so orders placed before this field existed still save/update fine
            address: { type: String, required: true },
            city: { type: String, required: true },
            state: { type: String, required: true },
            zip: { type: String, required: true },
            phone: { type: String },
        },
        shippingMethod: {
            type: String,
            enum: ['standard', 'express'],
            default: 'standard',
        },
        subtotal: { type: Number, required: true },
        shippingCost: { type: Number, required: true, default: 0 },
        // the coupon code applied at checkout, and how much it took off (both
        // re-validated and computed server-side - never trusted from the client)
        couponCode: { type: String },
        discount: { type: Number, default: 0 },
        total: { type: Number, required: true },
        status: {
            type: String,
            enum: ['pending', 'paid', 'shipped', 'delivered', 'cancelled'],
            default: 'pending',
        },
        paymentMethod: {
            type: String,
            enum: ['cod', 'stripe', 'jazzcash', 'easypaisa'],
            default: 'cod',
        },
        // set once a real payment gateway (Stripe/JazzCash/Easypaisa) confirms the
        // charge server-side - never trust a client-supplied "paid" flag
        transactionId: { type: String },
        paidAt: { type: Date },
        // internal reference used to reconcile Stripe PaymentIntents / gateway callbacks
        // back to this order
        paymentIntentId: { type: String },
        // SHA-256 of the secret the customer's browser received at checkout; lets a
        // guest (no login) prove the order is theirs. Never returned by the API
        // (select: false) - see utils/orderAccess.js.
        accessTokenHash: { type: String, select: false },
        cancelledAt: { type: Date },
        // The currency every amount on this order is in (see config/currency.js).
        currency: { type: String, default: 'USD' },
        // EXACT amount/currency the online gateway was asked to charge (JazzCash/Easypaisa charge
        // PKR, converted at a configured server-side rate). The gateway callback must match this.
        gatewayPayment: {
            provider: String,
            currency: String,
            amountMinor: Number, // cents / paisa
            rate: Number,
            orderTotalMinor: Number,
            orderCurrency: String,
            quotedAt: Date,
        },
        // Refund workflow for paid online orders (never pretend a refund happened):
        //   none -> pending (Stripe refund initiated) -> succeeded
        //   none -> manual_required (JazzCash/Easypaisa: refund in their portal) -> manual_done
        //   failed = the provider rejected/errored; the order was left untouched
        refundStatus: { type: String, enum: ['none', 'pending', 'succeeded', 'failed', 'manual_required', 'manual_done'], default: 'none' },
        // Payment-method switching on an unpaid order (see POST /api/payments/switch-method)
        paymentSwitchedAt: { type: Date },
        paymentSwitchCount: { type: Number, default: 0 }, // part of the Stripe idempotency key so a NEW intent can be made after a switch back
        // JazzCash/Easypaisa attempts that were replaced (method switched, or the payment was restarted).
        // Kept only so a late payment on an old attempt can be recognised and reconciled by hand.
        abandonedGatewayAttempts: [
            { provider: String, reference: String, amountMinor: Number, currency: String, abandonedAt: Date, _id: false },
        ],
        refundId: { type: String },
        refundedAt: { type: Date },
        refundNote: { type: String },
        // set when money arrived for an order that was already cancelled (e.g. the
        // abandoned-order cleanup ran just before a slow payment finished) - needs a
        // manual refund by an admin
        paymentIssue: { type: String },
    },
    { timestamps: true }
);

orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('Order', orderSchema);
