/**
 * One-time migration: run this ONCE right after adding email verification.
 *
 * Every account created before this update has no `isVerified` field in the
 * database, which the User schema now defaults to `false` — meaning every
 * existing account (including any admin account made with make-admin)
 * would otherwise be locked out until they "verify" an email that was
 * never sent for the old flow. This script marks all of them as verified so
 * only NEW signups from now on go through the email verification flow.
 *
 * Usage:
 *   node seed/verifyExistingUsers.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');

async function verifyExistingUsers() {
    await connectDB();

    const result = await User.updateMany({ isVerified: { $ne: true } }, { $set: { isVerified: true } });

    console.log(`Marked ${result.modifiedCount} existing account(s) as verified.`);
    console.log('From now on, only new signups will need to verify their email.');

    await mongoose.disconnect();
    process.exit(0);
}

verifyExistingUsers().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
