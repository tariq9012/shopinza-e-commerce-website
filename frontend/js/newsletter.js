/* ==========================================================
   Shopinza - newsletter.js
   Interactivity for the newsletter signup form on index.html.
   Calls the backend (POST /api/newsletter).
   Depends on config.js being loaded first.
   ========================================================== */

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('newsletter-form');
    const note = document.getElementById('newsletter-note');

    if (!form) return;

    const originalNoteText = note ? note.textContent : '';

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const emailInput = document.getElementById('newsletter-email');
        const email = emailInput ? emailInput.value.trim() : '';
        if (!email) return;

        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        const originalText = submitBtn.textContent;
        submitBtn.textContent = '...';

        try {
            const data = await Api.post('/newsletter', { email });
            if (note) {
                note.textContent = data.message;
                note.style.color = '#070235';
                note.style.fontWeight = '600';
            }
            form.reset();
        } catch (err) {
            if (note) {
                note.textContent = err.message;
                note.style.color = '#ba1a1a';
                note.style.fontWeight = '600';
            }
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;

            setTimeout(() => {
                if (note) {
                    note.textContent = originalNoteText;
                    note.style.color = '';
                    note.style.fontWeight = '';
                }
            }, 6000);
        }
    });
});
