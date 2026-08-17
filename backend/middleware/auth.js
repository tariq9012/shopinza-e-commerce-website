const jwt = require('jsonwebtoken');
const User = require('../models/User');

/** Requires a valid "Authorization: Bearer <token>" header. */
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        return res.status(401).json({ message: 'No token provided. Please sign in.' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Invalid or expired token. Please sign in again.' });
    }
}

/** Attaches req.userId if a valid token is present, but does not require one. */
function optionalAuth(req, _res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (token) {
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.userId = decoded.userId;
        } catch (err) {
            // ignore invalid token for optional auth
        }
    }

    next();
}

/**
 * Requires the signed-in user to have role "admin".
 * Must be used AFTER requireAuth (needs req.userId already set).
 */
async function requireAdmin(req, res, next) {
    try {
        const user = await User.findById(req.userId);

        if (!user) {
            return res.status(401).json({ message: 'Please sign in again.' });
        }

        if (user.role !== 'admin') {
            return res.status(403).json({ message: 'Admin access only.' });
        }

        req.user = user;
        next();
    } catch (err) {
        return res.status(500).json({ message: 'Could not verify admin access.' });
    }
}

module.exports = { requireAuth, optionalAuth, requireAdmin };