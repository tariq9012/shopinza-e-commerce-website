const mongoose = require('mongoose');

const colorSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        hex: { type: String, required: true },
    },
    { _id: false }
);

// One row of the color x size stock matrix, e.g. { color: 'Red', size: 'M', stock: 5 }.
// A product with an empty `variants` array has no size/color-specific stock -
// it behaves exactly like before this feature existed, using `stock` directly.
const variantSchema = new mongoose.Schema(
    {
        color: { type: String, required: true },
        size: { type: String, required: true },
        stock: { type: Number, default: 0, min: 0 },
    },
    { _id: false }
);

const productSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        slug: { type: String, required: true, unique: true },
        description: { type: String, default: '' },
        price: { type: Number, required: true, min: 0 },
        oldPrice: { type: Number, min: 0 },
        image: { type: String, required: true },
        images: { type: [String], default: [] },
        colors: { type: [colorSchema], default: [] },
        sizes: { type: [String], default: [] }, // e.g. ['S', 'M', 'L', 'XL'] - only meaningful alongside `variants`
        variants: { type: [variantSchema], default: [] },
        category: { type: String },
        // Total stock for products with NO size/color variants. Ignored for
        // checkout purposes once `variants` has entries - see
        // Product.availableStock() below - but still kept up to date (as the
        // sum of variant stock) so existing "X in stock" UI keeps working.
        stock: { type: Number, default: 50, min: 0 },
        rating: { type: Number, default: 0 },
        reviewCount: { type: Number, default: 0 },
    },
    { timestamps: true }
);

/** Total sellable units across every variant, or just `stock` if this product has no variants. */
productSchema.methods.availableStock = function availableStock() {
    if (!this.variants || this.variants.length === 0) return this.stock;
    return this.variants.reduce((sum, v) => sum + v.stock, 0);
};

// ---------- Indexes (keep listing/search fast once there are 1000+ products) ----------

// Full-text search across name/description/category, weighted so a name
// match ranks above a description match. Backs the `search` query param
// in GET /api/products (see routes/productRoutes.js).
productSchema.index(
    { name: 'text', description: 'text', category: 'text' },
    { weights: { name: 10, category: 5, description: 1 }, name: 'ProductTextIndex' }
);

// Speeds up the common filter/sort combinations (category filter, price
// sort, "latest" sort) instead of Mongo scanning every document.
productSchema.index({ category: 1 });
productSchema.index({ price: 1 });
productSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Product', productSchema);