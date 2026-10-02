const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
    {
        firstName: { type: String, required: true, trim: true },
        lastName: { type: String, required: true, trim: true },
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
        },
        // Only required for accounts created with email+password. Accounts
        // created via "Sign in with Google" or "Continue with Facebook" have
        // no password at all - see googleId/facebookId below - since the
        // provider itself handles their authentication.
        password: {
            type: String,
            required: function requiresPassword() {
                return !this.googleId && !this.facebookId;
            },
            minlength: 8,
        },
        role: { type: String, enum: ['user', 'admin'], default: 'user' },

        // Google's stable per-account id ("sub" claim), set when this
        // account was created or linked via "Sign in with Google". Sparse +
        // unique so two different Shopinza accounts can never link the same
        // Google account, while accounts without Google sign-in (most of
        // them) simply omit this field entirely.
        googleId: { type: String, unique: true, sparse: true },

        // Same idea as googleId, but for "Continue with Facebook".
        facebookId: { type: String, unique: true, sparse: true },

        // ---------- Email verification ----------
        isVerified: { type: Boolean, default: false },
        verifyTokenHash: { type: String },
        verifyTokenExpires: { type: Date },

        // ---------- Forgot / reset password ----------
        resetTokenHash: { type: String },
        resetTokenExpires: { type: Date },

        // Bumped whenever all existing sessions should be invalidated
        // (password reset, password change, "sign out everywhere").
        // Refresh tokens embed the tokenVersion they were issued with, so a
        // mismatch means "this refresh token is no longer valid".
        tokenVersion: { type: Number, default: 0 },
    },
    { timestamps: true }
);

// hash the password automatically whenever it is created/changed
// (Google accounts have no password at all - see googleId above - so skip silently)
userSchema.pre('save', async function hashPassword(next) {
    if (!this.password || !this.isModified('password')) return next();

    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
    if (!this.password) return Promise.resolve(false); // Google-only account - no password to compare against
    return bcrypt.compare(candidate, this.password);
};

// never send the password hash or internal security tokens back in API responses
userSchema.set('toJSON', {
    transform: (_doc, ret) => {
        delete ret.password;
        delete ret.verifyTokenHash;
        delete ret.verifyTokenExpires;
        delete ret.resetTokenHash;
        delete ret.resetTokenExpires;
        delete ret.tokenVersion;
        return ret;
    },
});

module.exports = mongoose.model('User', userSchema);