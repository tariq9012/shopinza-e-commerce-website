const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
    {
        productId: { type: String, required: true },
        name: { type: String, required: true },
        price: { type: Number, required: true },
        image: { type: String },
        qty: { type: Number, required: true, min: 1 },
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
        total: { type: Number, required: true },
        status: {
            type: String,
            enum: ['pending', 'paid', 'shipped', 'delivered', 'cancelled'],
            default: 'pending',
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Order', orderSchema);
