/* ==========================================================
   Shopinza - auth.js
   Interactivity for login.html: toggles between Sign In and
   Create Account forms, and calls the backend auth API
   (POST /api/auth/login, POST /api/auth/register).
   Depends on config.js being loaded first.
   ========================================================== */

document.addEventListener('DOMContentLoaded', () => {
    const toggleBtn = document.getElementById('toggle-form-btn');
    const toggleText = document.getElementById('toggle-text');
    const loginForm = document.getElementById('form-login');
    const signupForm = document.getElementById('form-signup');
    const pageTitle = document.getElementById('page-title');
    const pageSubtitle = document.getElementById('page-subtitle');

    let isLogin = true;

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            isLogin = !isLogin;

            if (isLogin) {
                pageTitle.textContent = 'Welcome back';
                pageSubtitle.textContent = 'Enter your credentials to access your curated collection.';
                toggleText.textContent = "Don't have an account?";
                toggleBtn.textContent = 'Sign Up';
                signupForm.classList.add('hidden');
                loginForm.classList.remove('hidden');
            } else {
                pageTitle.textContent = 'Join Shopinza';
                pageSubtitle.textContent = 'Create an account to elevate your luxury experience.';
                toggleText.textContent = 'Already have an account?';
                toggleBtn.textContent = 'Sign In';
                loginForm.classList.add('hidden');
                signupForm.classList.remove('hidden');
            }
        });
    }

    function showFeedback(el, message, isSuccess) {
        if (!el) return;
        el.textContent = message;
        el.classList.remove('hidden');
        el.style.color = isSuccess ? '#8de08d' : '#ff9b9b';
    }

    /* ---------- Login form ---------- */
    if (loginForm) {
        loginForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const feedback = document.getElementById('login-feedback');
            const submitBtn = loginForm.querySelector('.auth-submit');
            const email = document.getElementById('login-email').value.trim();
            const password = document.getElementById('login-password').value;

            if (!email || !password) {
                showFeedback(feedback, 'Please fill in both fields.');
                return;
            }

            submitBtn.disabled = true;
            const originalHTML = submitBtn.innerHTML;
            submitBtn.textContent = 'Please wait…';

            try {
                const data = await Api.post('/auth/login', { email, password });
                Api.setToken(data.token);
                showFeedback(feedback, `Welcome back, ${data.user.firstName}! Redirecting…`, true);
                setTimeout(() => {
                    window.location.href = data.user.role === 'admin' ? 'admin/dashboard.html' : 'index.html';
                }, 800);
            } catch (err) {
                showFeedback(feedback, err.message);
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalHTML;
            }
        });
    }

    /* ---------- Sign up form ---------- */
    if (signupForm) {
        signupForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const feedback = document.getElementById('signup-feedback');
            const submitBtn = signupForm.querySelector('.auth-submit');
            const firstName = document.getElementById('signup-fname').value.trim();
            const lastName = document.getElementById('signup-lname').value.trim();
            const email = document.getElementById('signup-email').value.trim();
            const password = document.getElementById('signup-password').value;

            if (!firstName || !lastName || !email || !password) {
                showFeedback(feedback, 'Please fill in every field.');
                return;
            }

            if (password.length < 8) {
                showFeedback(feedback, 'Password must be at least 8 characters.');
                return;
            }

            submitBtn.disabled = true;
            const originalText = submitBtn.textContent;
            submitBtn.textContent = 'Please wait…';

            try {
                const data = await Api.post('/auth/register', { firstName, lastName, email, password });
                Api.setToken(data.token);
                showFeedback(feedback, `Welcome to Shopinza, ${data.user.firstName}! Redirecting…`, true);
                setTimeout(() => {
                    window.location.href = 'index.html';
                }, 800);
            } catch (err) {
                showFeedback(feedback, err.message);
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        });
    }

    /* ---------- Social buttons (not implemented yet) ---------- */
    document.querySelectorAll('.social-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            alert('Google/Apple sign-in is not set up yet — this needs OAuth credentials from Google/Apple to be added to the backend later.');
        });
    });
});