/* ==========================================================
   Shopinza - contact.js
   Interactivity for contact.html: validates and submits the
   contact form to the backend (POST /api/contact).
   Depends on config.js being loaded first.
   ========================================================== */

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('contact-form');
    const feedback = document.getElementById('contact-form-feedback');

    if (!form) return;

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const name = document.getElementById('c-name').value.trim();
        const email = document.getElementById('c-email').value.trim();
        const subject = document.getElementById('c-subject').value;
        const message = document.getElementById('c-message').value.trim();

        if (!name || !email || !message) {
            if (feedback) {
                feedback.textContent = 'Please fill in your name, email, and message.';
                feedback.style.color = '#ba1a1a';
                feedback.classList.remove('hidden');
            }
            return;
        }

        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        const originalText = submitBtn.textContent;
        submitBtn.textContent = 'Sending…';

        try {
            const data = await Api.post('/contact', { name, email, subject, message });
            if (feedback) {
                feedback.textContent = data.message;
                feedback.style.color = '#070235';
                feedback.classList.remove('hidden');
            }
            form.reset();
        } catch (err) {
            if (feedback) {
                feedback.textContent = err.message;
                feedback.style.color = '#ba1a1a';
                feedback.classList.remove('hidden');
            }
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    });
});
