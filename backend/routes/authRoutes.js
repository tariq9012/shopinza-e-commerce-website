const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { isString, isEmail, escapeHtml } = require('../utils/validate');
const { sendMail } = require('../utils/mailer');
const {
    signAccessToken,
    signRefreshToken,
    verifyRefreshToken,
    generateRawToken,
    hashToken,
} = require('../utils/tokens');

const router = express.Router();
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Where the frontend is served from - used to build the links inside emails.
// e.g. http://127.0.0.1:5501/shopinza-e-commerce-website/frontend
const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://127.0.0.1:5501').replace(/\/$/, '');

const VERIFY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Issues a fresh access + refresh token pair for a user. */
function issueTokens(user) {
    return {
        token: signAccessToken(user._id),
        refreshToken: signRefreshToken(user._id, user.tokenVersion),
    };
}

async function sendVerificationEmail(user) {
    const rawToken = generateRawToken();
    user.verifyTokenHash = hashToken(rawToken);
    user.verifyTokenExpires = new Date(Date.now() + VERIFY_TOKEN_TTL_MS);
    await user.save();

    const link = `${FRONTEND_URL}/verify-email.html?token=${rawToken}`;

    await sendMail({
        to: user.email,
        subject: 'Verify your Shopinza account',
        html: `
            <p>Hi ${escapeHtml(user.firstName)},</p>
            <p>Thanks for creating a Shopinza account. Please confirm this is your email address by clicking the link below:</p>
            <p><a href="${link}">Verify my email</a></p>
            <p>This link expires in 24 hours. If you didn't create a Shopinza account, you can ignore this email.</p>
        `,
    });
}

// GET /api/auth/public-config
// The static frontend cannot read Vercel environment variables, so it asks the API
// for the two PUBLIC social-login identifiers (Google client id, Facebook app id).
// Never put a secret here - the Facebook APP SECRET stays server-side only.
router.get('/public-config', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
        googleClientId: process.env.GOOGLE_CLIENT_ID || '',
        facebookAppId: process.env.FACEBOOK_APP_ID || '',
    });
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
    try {
        const { firstName, lastName, email, password } = req.body || {};

        // every field must be a real string (not an object/array) of sane length
        if (!isString(firstName, { max: 80 }) || !isString(lastName, { max: 80 }) || !isString(email, { max: 254 }) || !isString(password, { max: 128 })) {
            return res.status(400).json({ message: 'Please fill in every field.' });
        }

        if (!isEmail(email)) {
            return res.status(400).json({ message: 'Please enter a valid email address.' });
        }

        // (bcrypt only uses the first 72 bytes and a huge password is a cheap DoS, hence the 128 cap above)
        if (password.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters.' });
        }

        const existing = await User.findOne({ email: email.toLowerCase() });
        if (existing) {
            return res.status(409).json({ message: 'An account with this email already exists.' });
        }

        const user = await User.create({ firstName, lastName, email, password });
        await sendVerificationEmail(user);

        // NOTE: unlike before, we do NOT log the user in yet - the account
        // can't be used until the email is confirmed, otherwise anyone could
        // sign up with a fake/someone else's email address.
        res.status(201).json({
            message: `We've sent a verification link to ${user.email}. Please check your inbox to activate your account.`,
            email: user.email,
        });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ message: 'Something went wrong while creating your account.' });
    }
});

// GET /api/auth/verify-email?token=...
router.get('/verify-email', async (req, res) => {
    try {
        const { token } = req.query;
        if (!isString(token, { max: 256 })) return res.status(400).json({ message: 'Missing verification token.' });

        const user = await User.findOne({
            verifyTokenHash: hashToken(token),
            verifyTokenExpires: { $gt: new Date() },
        });

        if (!user) {
            return res.status(400).json({
                message: 'This verification link is invalid or has expired. Please request a new one.',
            });
        }

        user.isVerified = true;
        user.verifyTokenHash = undefined;
        user.verifyTokenExpires = undefined;
        await user.save();

        res.json({ message: 'Your email has been verified! You can now sign in.' });
    } catch (err) {
        console.error('Verify email error:', err);
        res.status(500).json({ message: 'Something went wrong while verifying your email.' });
    }
});

// POST /api/auth/resend-verification  - body: { email }
router.post('/resend-verification', async (req, res) => {
    try {
        const { email } = req.body || {};
        if (!isString(email, { max: 254 })) return res.status(400).json({ message: 'Please enter your email address.' });

        const user = await User.findOne({ email: email.toLowerCase() });

        // Same response whether or not the account exists / is already
        // verified, so this endpoint can't be used to check which emails
        // have an account (user enumeration).
        if (user && !user.isVerified) {
            await sendVerificationEmail(user);
        }

        res.json({
            message: `If an unverified account exists for ${email}, we've sent a new verification link.`,
        });
    } catch (err) {
        console.error('Resend verification error:', err);
        res.status(500).json({ message: 'Something went wrong. Please try again.' });
    }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};

        if (!isString(email, { max: 254 }) || !isString(password, { max: 128 })) {
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

        if (!user.isVerified) {
            return res.status(403).json({
                message: 'Please verify your email before signing in.',
                needsVerification: true,
                email: user.email,
            });
        }

        const { token, refreshToken } = issueTokens(user);
        res.json({ token, refreshToken, user });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'Something went wrong while signing you in.' });
    }
});

// POST /api/auth/google  - body: { credential }  (the ID token from Google Identity Services)
// Verifies the token directly with Google (no client secret needed for this
// flow), then finds/creates/links the matching account. Google has already
// confirmed the email address, so these accounts are marked verified
// immediately - no separate verification email needed.
router.post('/google', async (req, res) => {
    try {
        if (!process.env.GOOGLE_CLIENT_ID) {
            return res.status(503).json({ message: 'Google Sign-In is not configured on the server yet.' });
        }

        const { credential } = req.body || {};
        if (!isString(credential, { max: 4096 })) return res.status(400).json({ message: 'Missing Google credential.' });

        let payload;
        try {
            const ticket = await googleClient.verifyIdToken({
                idToken: credential,
                audience: process.env.GOOGLE_CLIENT_ID,
            });
            payload = ticket.getPayload();
        } catch (err) {
            return res.status(401).json({ message: 'Could not verify this Google sign-in. Please try again.' });
        }

        if (!payload.email_verified) {
            return res.status(401).json({ message: 'This Google account\'s email is not verified.' });
        }

        let user = await User.findOne({ email: payload.email.toLowerCase() });

        if (user) {
            // Existing account (may have been created with email+password) -
            // link this Google account to it if it isn't already.
            if (!user.googleId) {
                user.googleId = payload.sub;
                if (!user.isVerified) user.isVerified = true; // Google already verified this email
                await user.save();
            }
        } else {
            user = await User.create({
                firstName: payload.given_name || 'Shopinza',
                lastName: payload.family_name || 'User',
                email: payload.email,
                googleId: payload.sub,
                isVerified: true,
            });
        }

        const { token, refreshToken } = issueTokens(user);
        res.json({ token, refreshToken, user });
    } catch (err) {
        console.error('Google sign-in error:', err);
        res.status(500).json({ message: 'Something went wrong while signing you in with Google.' });
    }
});

// POST /api/auth/facebook  - body: { accessToken, userID }  (from the Facebook JS SDK's FB.login())
// Verifies the token belongs to OUR app (via Facebook's debug_token
// endpoint) before trusting it, then finds/creates/links the matching
// account - same pattern as the Google route above.
router.post('/facebook', async (req, res) => {
    try {
        if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET) {
            return res.status(503).json({ message: 'Facebook Login is not configured on the server yet.' });
        }

        const { accessToken, userID } = req.body || {};
        if (!isString(accessToken, { max: 2048 }) || !isString(userID, { max: 64 })) {
            return res.status(400).json({ message: 'Missing Facebook credentials.' });
        }

        // Confirm this token was actually issued by OUR Facebook app, for
        // this exact user - never trust a client-supplied token as-is.
        const appAccessToken = `${process.env.FACEBOOK_APP_ID}|${process.env.FACEBOOK_APP_SECRET}`;
        let debugData;
        try {
            const debugRes = await fetch(
                `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(appAccessToken)}`
            );
            debugData = await debugRes.json();
        } catch (err) {
            return res.status(502).json({ message: 'Could not reach Facebook to verify this sign-in. Please try again.' });
        }

        const tokenInfo = debugData && debugData.data;
        if (!tokenInfo || !tokenInfo.is_valid || tokenInfo.app_id !== process.env.FACEBOOK_APP_ID || tokenInfo.user_id !== userID) {
            return res.status(401).json({ message: 'Could not verify this Facebook sign-in. Please try again.' });
        }

        // Token is confirmed genuine - now fetch the actual profile with it.
        const profileRes = await fetch(
            `https://graph.facebook.com/${encodeURIComponent(userID)}?fields=id,first_name,last_name,email&access_token=${encodeURIComponent(accessToken)}`
        );
        const profile = await profileRes.json();

        if (!profile.email) {
            return res.status(400).json({
                message:
                    'Your Facebook account has no email address available. Please allow email access, or sign in with email/password instead.',
            });
        }

        let user = await User.findOne({ email: profile.email.toLowerCase() });

        if (user) {
            // Existing account (may have been created with email+password, or
            // via Google) - link this Facebook account to it if it isn't already.
            if (!user.facebookId) {
                user.facebookId = profile.id;
                if (!user.isVerified) user.isVerified = true; // Facebook already confirmed this email
                await user.save();
            }
        } else {
            user = await User.create({
                firstName: profile.first_name || 'Shopinza',
                lastName: profile.last_name || 'User',
                email: profile.email,
                facebookId: profile.id,
                isVerified: true,
            });
        }

        const { token, refreshToken } = issueTokens(user);
        res.json({ token, refreshToken, user });
    } catch (err) {
        console.error('Facebook sign-in error:', err);
        res.status(500).json({ message: 'Something went wrong while signing you in with Facebook.' });
    }
});

// POST /api/auth/refresh  - body: { refreshToken }
// Exchanges a still-valid refresh token for a new access token (and a
// rotated refresh token), so the user stays signed in without the access
// token needing a long expiry.
router.post('/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body || {};
        if (!isString(refreshToken, { max: 2048 })) return res.status(400).json({ message: 'Missing refresh token.' });

        let decoded;
        try {
            decoded = verifyRefreshToken(refreshToken);
        } catch (err) {
            return res.status(401).json({ message: 'Your session has expired. Please sign in again.' });
        }

        const user = await User.findById(decoded.userId);
        if (!user) {
            return res.status(401).json({ message: 'Please sign in again.' });
        }

        // tokenVersion mismatch = this refresh token was issued before a
        // password reset (or a future "sign out everywhere" action) - reject it.
        if (user.tokenVersion !== decoded.tokenVersion) {
            return res.status(401).json({ message: 'Your session is no longer valid. Please sign in again.' });
        }

        const { token, refreshToken: newRefreshToken } = issueTokens(user);
        res.json({ token, refreshToken: newRefreshToken });
    } catch (err) {
        console.error('Refresh token error:', err);
        res.status(500).json({ message: 'Something went wrong while refreshing your session.' });
    }
});

// POST /api/auth/forgot-password  - body: { email }
router.post('/forgot-password', async (req, res) => {
    try {
        const { email } = req.body || {};
        if (!isString(email, { max: 254 })) return res.status(400).json({ message: 'Please enter your email address.' });

        const user = await User.findOne({ email: email.toLowerCase() });

        // Always the same response, whether or not the account exists -
        // otherwise this endpoint could be used to find out which emails
        // are registered.
        if (user) {
            const rawToken = generateRawToken();
            user.resetTokenHash = hashToken(rawToken);
            user.resetTokenExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
            await user.save();

            const link = `${FRONTEND_URL}/reset-password.html?token=${rawToken}`;

            await sendMail({
                to: user.email,
                subject: 'Reset your Shopinza password',
                html: `
                    <p>Hi ${escapeHtml(user.firstName)},</p>
                    <p>We received a request to reset your Shopinza password. Click the link below to choose a new one:</p>
                    <p><a href="${link}">Reset my password</a></p>
                    <p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email - your password won't be changed.</p>
                `,
            });
        }

        res.json({
            message: `If an account exists for ${email}, we've sent a password reset link.`,
        });
    } catch (err) {
        console.error('Forgot password error:', err);
        res.status(500).json({ message: 'Something went wrong. Please try again.' });
    }
});

// POST /api/auth/reset-password  - body: { token, password }
router.post('/reset-password', async (req, res) => {
    try {
        const { token, password } = req.body || {};

        if (!isString(token, { max: 256 }) || !isString(password, { max: 128 })) {
            return res.status(400).json({ message: 'Missing token or new password.' });
        }
        if (password.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters.' });
        }

        const user = await User.findOne({
            resetTokenHash: hashToken(token),
            resetTokenExpires: { $gt: new Date() },
        });

        if (!user) {
            return res.status(400).json({
                message: 'This reset link is invalid or has expired. Please request a new one.',
            });
        }

        user.password = password; // re-hashed automatically by the pre-save hook
        user.resetTokenHash = undefined;
        user.resetTokenExpires = undefined;
        // invalidate every refresh token issued before this point, on every
        // device - anyone who had a stale session (or the leaked password)
        // is signed out.
        user.tokenVersion += 1;
        await user.save();

        res.json({ message: 'Your password has been reset. You can now sign in with your new password.' });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({ message: 'Something went wrong while resetting your password.' });
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
