const mongoose = require('mongoose');

const contactMessageSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        email: { type: String, required: true, trim: true, lowercase: true },
        subject: { type: String, default: 'Order Support' },
        message: { type: String, required: true },
        resolved: { type: Boolean, default: false },
    },
    { timestamps: true }
);

module.exports = mongoose.model('ContactMessage', contactMessageSchema);
