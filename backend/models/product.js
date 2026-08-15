const mongoose = require('mongoose');

const colorSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        hex: { type: String, required: true },
    },
    { _id: false }
);

const productSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        slug: { type: String, required: true, unique: true },
        description: { type: String, default: '' },
        price: { type: Number, required: true },
        oldPrice: { type: Number },
        image: { type: String, required: true },
        images: { type: [String], default: [] },
        colors: { type: [colorSchema], default: [] },
        category: { type: String },
        stock: { type: Number, default: 50 },
        rating: { type: Number, default: 0 },
        reviewCount: { type: Number, default: 0 },
    },
    { timestamps: true }
);

module.exports = mongoose.model('Product', productSchema);