const mongoose = require('mongoose');

// Mirrors the shape the frontend already keeps in localStorage
// (see frontend/js/cart.js), so syncing is a straight copy either way.
const cartItemSchema = new mongoose.Schema(
    {
        id: { type: String, required: true }, // matches Cart.addItem's product id on the frontend
        name: { type: String, required: true },
        price: { type: Number, required: true },
        image: { type: String },
        qty: { type: Number, required: true, min: 1 },
    },
    { _id: false }
);

const cartSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
        items: { type: [cartItemSchema], default: [] },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Cart', cartSchema);
