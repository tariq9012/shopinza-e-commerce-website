const express = require('express');
const Subscriber = require('../models/Subscriber');

const router = express.Router();

// POST /api/newsletter
router.post('/', async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ message: 'Please enter your email address.' });
        }

        const existing = await Subscriber.findOne({ email: email.toLowerCase() });
        if (existing) {
            return res.status(200).json({ message: "You're already subscribed — thanks for being here!" });
        }

        await Subscriber.create({ email });
        res.status(201).json({ message: 'Thanks for subscribing to Shopinza!' });
    } catch (err) {
        console.error('Newsletter error:', err);
        res.status(500).json({ message: 'Something went wrong while subscribing.' });
    }
});

module.exports = router;
