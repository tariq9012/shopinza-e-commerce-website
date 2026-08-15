const express = require('express');
const ContactMessage = require('../models/ContactMessage');

const router = express.Router();

// POST /api/contact
router.post('/', async (req, res) => {
    try {
        const { name, email, subject, message } = req.body;

        if (!name || !email || !message) {
            return res.status(400).json({ message: 'Please fill in your name, email, and message.' });
        }

        const contactMessage = await ContactMessage.create({ name, email, subject, message });
        res.status(201).json({
            message: 'Thanks! Your message has been received — our team will get back to you soon.',
            id: contactMessage._id,
        });
    } catch (err) {
        console.error('Contact form error:', err);
        res.status(500).json({ message: 'Something went wrong while sending your message.' });
    }
});

module.exports = router;
