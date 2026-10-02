const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema(
    {
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        rating: { type: Number, required: true, min: 1, max: 5 },
        comment: { type: String, required: true, trim: true, maxlength: 1000 },
        images: { type: [String], default: [] },
        // true whenever the reviewer actually has a paid/shipped/delivered order
        // containing this product - every review created through the API is
        // verified by definition, but the flag makes intent explicit on the model.
        verifiedPurchase: { type: Boolean, default: false },
    },
    { timestamps: true }
);

// a user can only leave one review per product - re-submitting should edit, not duplicate
reviewSchema.index({ product: 1, user: 1 }, { unique: true });

module.exports = mongoose.model('Review', reviewSchema);
