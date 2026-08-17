const express = require('express');
const ContactMessage = require('../models/ContactMessage');
const { requireAuth, requireAdmin } = require('../middleware/auth');

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

/* ============================================================
   Admin-only routes below (require a valid admin JWT token)
   ============================================================ */

// GET /api/contact  - list all contact messages, newest first
router.get('/', requireAuth, requireAdmin, async (req, res) => {
    try {
        const messages = await ContactMessage.find().sort({ createdAt: -1 });
        res.json({ messages });
    } catch (err) {
        console.error('Admin get contact messages error:', err);
        res.status(500).json({ message: 'Could not load messages.' });
    }
});

// PATCH /api/contact/:id/resolve  - toggle a message's resolved state
router.patch('/:id/resolve', requireAuth, requireAdmin, async (req, res) => {
    try {
        const message = await ContactMessage.findById(req.params.id);
        if (!message) return res.status(404).json({ message: 'Message not found.' });

        message.resolved = !message.resolved;
        await message.save();

        res.json({ message: message });
    } catch (err) {
        console.error('Resolve message error:', err);
        res.status(500).json({ message: 'Could not update message.' });
    }
});

module.exports = router;