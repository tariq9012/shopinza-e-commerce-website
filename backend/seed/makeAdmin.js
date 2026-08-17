/**
 * Promotes an existing user to the "admin" role so they can access
 * the admin dashboard. The user must already have an account
 * (sign up normally on the website first), then run this script.
 *
 * Usage:
 *   node seed/makeAdmin.js your-email@example.com
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');

async function makeAdmin() {
    const email = process.argv[2];

    if (!email) {
        console.error('Usage: node seed/makeAdmin.js your-email@example.com');
        process.exit(1);
    }

    await connectDB();

    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
        console.error(`No account found for ${email}. Sign up on the website first, then run this again.`);
        await mongoose.disconnect();
        process.exit(1);
    }

    user.role = 'admin';
    await user.save();

    console.log(`${user.email} is now an admin. They can sign in at login.html and will be redirected to the admin dashboard.`);
    await mongoose.disconnect();
    process.exit(0);
}

makeAdmin().catch((err) => {
    console.error('Failed to promote user:', err);
    process.exit(1);
});