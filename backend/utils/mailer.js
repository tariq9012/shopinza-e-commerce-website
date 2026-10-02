const nodemailer = require('nodemailer');

let cachedTransporter = null;
let loggedDevModeWarning = false;

function isSmtpConfigured() {
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
    if (cachedTransporter) return cachedTransporter;

    cachedTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: Number(process.env.SMTP_PORT) === 465, // true for port 465, false for 587/25
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });

    return cachedTransporter;
}

/**
 * Sends an email. If SMTP_HOST/SMTP_USER/SMTP_PASS aren't set in .env yet,
 * falls back to printing the email to the terminal instead of throwing -
 * so signup / forgot-password can be developed and tested locally before
 * real email credentials are configured.
 *
 * To send real emails: set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and
 * EMAIL_FROM in backend/.env. Any SMTP provider works (Gmail with an App
 * Password, Mailtrap for testing, SendGrid, Brevo, etc).
 */
async function sendMail({ to, subject, html }) {
    if (!isSmtpConfigured()) {
        if (!loggedDevModeWarning) {
            console.log(
                '\n[mailer] SMTP is not configured in backend/.env — printing emails to the terminal instead of sending them.\n' +
                    '[mailer] Set SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / EMAIL_FROM to send real emails.\n'
            );
            loggedDevModeWarning = true;
        }
        console.log(`\n[mailer] ---- Email to ${to} ----`);
        console.log(`[mailer] Subject: ${subject}`);
        console.log(`[mailer] ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`);
        console.log('[mailer] ------------------------------\n');
        return { devMode: true };
    }

    const transporter = getTransporter();
    return transporter.sendMail({
        from: process.env.EMAIL_FROM || `"Shopinza" <${process.env.SMTP_USER}>`,
        to,
        subject,
        html,
    });
}

module.exports = { sendMail };
