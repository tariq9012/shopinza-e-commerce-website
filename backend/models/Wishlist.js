const mongoose = require('mongoose');

const wishlistSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
        // product slugs (matches Wishlist.toggle()'s id on the frontend, and
        // the same "id" used for cart items - see frontend/js/cart.js)
        productIds: { type: [String], default: [] },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Wishlist', wishlistSchema);
