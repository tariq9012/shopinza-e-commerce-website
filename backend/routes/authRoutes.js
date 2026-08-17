const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function signToken(userId) {
    return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
    try {
        const { firstName, lastName, email, password } = req.body;

        if (!firstName || !lastName || !email || !password) {
            return res.status(400).json({ message: 'Please fill in every field.' });
        }

        if (password.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters.' });
        }

        const existing = await User.findOne({ email: email.toLowerCase() });
        if (existing) {
            return res.status(409).json({ message: 'An account with this email already exists.' });
        }

        const user = await User.create({ firstName, lastName, email, password });
        const token = signToken(user._id);

        res.status(201).json({ token, user });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ message: 'Something went wrong while creating your account.' });
    }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ message: 'Please enter your email and password.' });
        }

        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid email or password.' });
        }

        const token = signToken(user._id);
        res.json({ token, user });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'Something went wrong while signing you in.' });
    }
});

// GET /api/auth/me  (requires token) - used to check if a saved token is still valid
router.get('/me', requireAuth, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) return res.status(404).json({ message: 'User not found.' });
        res.json({ user });
    } catch (err) {
        res.status(500).json({ message: 'Something went wrong.' });
    }
});

module.exports = router;
