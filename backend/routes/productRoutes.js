const express = require('express');
const Product = require('../models/Product');

const router = express.Router();

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

module.exports = router;
