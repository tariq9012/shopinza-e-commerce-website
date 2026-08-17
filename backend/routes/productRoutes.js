const express = require('express');
const Product = require('../models/Product');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function slugify(text) {
    return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// GET /api/products?category=Electronics&sort=price_asc&limit=4
router.get('/', async (req, res) => {
    try {
        const { category, sort, limit } = req.query;
        const filter = {};
        if (category) filter.category = category;

        let query = Product.find(filter);

        if (sort === 'price_asc') query = query.sort({ price: 1 });
        if (sort === 'price_desc') query = query.sort({ price: -1 });
        if (sort === 'latest') query = query.sort({ createdAt: -1 });

        if (limit) query = query.limit(parseInt(limit, 10) || 0);

        const products = await query.exec();
        res.json({ products });
    } catch (err) {
        console.error('Get products error:', err);
        res.status(500).json({ message: 'Could not load products.' });
    }
});

// GET /api/products/:slug
router.get('/:slug', async (req, res) => {
    try {
        const product = await Product.findOne({ slug: req.params.slug });
        if (!product) return res.status(404).json({ message: 'Product not found.' });
        res.json({ product });
    } catch (err) {
        res.status(500).json({ message: 'Could not load this product.' });
    }
});

/* ============================================================
   Admin-only routes below (require a valid admin JWT token)
   ============================================================ */

// POST /api/products  (create a new product)
router.post('/', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { name, description, category, price, oldPrice, image, images, colors, stock } = req.body;

        if (!name || !category || price === undefined || !image) {
            return res.status(400).json({ message: 'Name, category, price, and image are required.' });
        }

        let slug = slugify(name);
        const existing = await Product.findOne({ slug });
        if (existing) {
            slug = `${slug}-${Date.now().toString().slice(-5)}`;
        }

        const product = await Product.create({
            slug,
            name,
            description,
            category,
            price,
            oldPrice: oldPrice || undefined,
            image,
            images: images || [],
            colors: colors || [],
            stock: stock !== undefined ? stock : 20,
        });

        res.status(201).json({ product });
    } catch (err) {
        console.error('Create product error:', err);
        res.status(500).json({ message: 'Could not create product.' });
    }
});

// PUT /api/products/id/:id  (update an existing product by its Mongo _id)
router.put('/id/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { name, description, category, price, oldPrice, image, images, colors, stock } = req.body;

        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ message: 'Product not found.' });

        if (name && name !== product.name) {
            product.name = name;
            let slug = slugify(name);
            const existing = await Product.findOne({ slug, _id: { $ne: product._id } });
            product.slug = existing ? `${slug}-${Date.now().toString().slice(-5)}` : slug;
        }

        if (description !== undefined) product.description = description;
        if (category !== undefined) product.category = category;
        if (price !== undefined) product.price = price;
        product.oldPrice = oldPrice || undefined;
        if (image !== undefined) product.image = image;
        if (images !== undefined) product.images = images;
        if (colors !== undefined) product.colors = colors;
        if (stock !== undefined) product.stock = stock;

        await product.save();
        res.json({ product });
    } catch (err) {
        console.error('Update product error:', err);
        res.status(500).json({ message: 'Could not update product.' });
    }
});

// DELETE /api/products/id/:id
router.delete('/id/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const product = await Product.findByIdAndDelete(req.params.id);
        if (!product) return res.status(404).json({ message: 'Product not found.' });
        res.json({ message: 'Product deleted.' });
    } catch (err) {
        console.error('Delete product error:', err);
        res.status(500).json({ message: 'Could not delete product.' });
    }
});

module.exports = router;