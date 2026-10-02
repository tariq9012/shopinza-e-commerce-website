/* ==========================================================
   Shopinza - auth.js
   Interactivity for login.html: toggles between Sign In and
   Create Account forms, and calls the backend auth API
   (POST /api/auth/login, POST /api/auth/register).
   Depends on config.js being loaded first.
   ========================================================== */

function showFeedback(el, message, isSuccess) {
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    el.style.color = isSuccess ? '#8de08d' : '#ff9b9b';
}

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
                Api.setToken(data.token, data.refreshToken);
                Api.setUserName(data.user.firstName);
                // pull/merge the account's saved cart and wishlist with
                // whatever was in this browser's guest versions before login
                if (typeof Cart !== 'undefined') {
                    await Cart.mergeAfterLogin();
                }
                if (typeof Wishlist !== 'undefined') {
                    await Wishlist.mergeAfterLogin();
                }
                showFeedback(feedback, `Welcome back, ${data.user.firstName}! Redirecting…`, true);
                setTimeout(() => {
                    window.location.href = data.user.role === 'admin' ? 'admin/dashboard.html' : 'index.html';
                }, 800);
            } catch (err) {
                if (err.data && err.data.needsVerification) {
                    showResendPrompt(feedback, err.data.email, err.message);
                } else {
                    showFeedback(feedback, err.message);
                }
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalHTML;
            }
        });
    }

    /** Shows the "please verify your email" message with a working resend link. */
    function showResendPrompt(feedbackEl, email, message) {
        if (!feedbackEl) return;
        feedbackEl.innerHTML = `${message} <a href="#" id="resend-verification-link">Resend verification email</a>`;
        feedbackEl.classList.remove('hidden');
        feedbackEl.style.color = '#ff9b9b';

        const resendLink = document.getElementById('resend-verification-link');
        if (resendLink) {
            resendLink.addEventListener('click', async (event) => {
                event.preventDefault();
                resendLink.textContent = 'Sending…';
                try {
                    const data = await Api.post('/auth/resend-verification', { email });
                    feedbackEl.textContent = data.message;
                    feedbackEl.style.color = '#8de08d';
                } catch (err) {
                    feedbackEl.textContent = err.message;
                }
            });
        }
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
                // NOTE: no Api.setToken() here anymore - the account can't
                // be used until the email link is clicked, so we don't log
                // the user in yet. The guest cart stays safely in
                // localStorage and will merge in automatically once they
                // verify and log in (see Cart.mergeAfterLogin in cart.js).
                showFeedback(feedback, data.message, true);
                signupForm.reset();
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            } catch (err) {
                showFeedback(feedback, err.message);
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        });
    }

    // Google/Facebook ids come from the server (Vercel env variables) unless hard-coded in config.js
    Api.loadPublicConfig().then(() => {
        /* ---------- Google Sign-In ---------- */
        const googleContainer = document.getElementById('google-signin-container');
        if (googleContainer && GOOGLE_CLIENT_ID) {
            initGoogleSignIn(googleContainer);
        }

        /* ---------- Facebook Login ---------- */
        const facebookBtn = document.getElementById('facebook-signin-btn');
        if (facebookBtn) {
            if (FACEBOOK_APP_ID) {
                initFacebookSignIn(facebookBtn);
            } else {
                facebookBtn.style.display = 'none'; // not configured yet - same treatment as Google above
            }
        }
    });

    /* ---------- Forgot password form (forgot-password.html) ---------- */
    const forgotForm = document.getElementById('form-forgot-password');
    if (forgotForm) {
        forgotForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const feedback = document.getElementById('forgot-feedback');
            const submitBtn = forgotForm.querySelector('.auth-submit');
            const email = document.getElementById('forgot-email').value.trim();

            if (!email) {
                showFeedback(feedback, 'Please enter your email address.');
                return;
            }

            submitBtn.disabled = true;
            const originalText = submitBtn.textContent;
            submitBtn.textContent = 'Please wait…';

            try {
                const data = await Api.post('/auth/forgot-password', { email });
                showFeedback(feedback, data.message, true);
                forgotForm.reset();
            } catch (err) {
                showFeedback(feedback, err.message);
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        });
    }

    /* ---------- Reset password form (reset-password.html?token=...) ---------- */
    const resetForm = document.getElementById('form-reset-password');
    if (resetForm) {
        const urlParams = new URLSearchParams(window.location.search);
        const resetToken = urlParams.get('token');
        const feedback = document.getElementById('reset-feedback');

        if (!resetToken) {
            showFeedback(feedback, 'This reset link is missing its token. Please request a new one from the Forgot Password page.');
            resetForm.querySelector('.auth-submit').disabled = true;
        }

        resetForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const submitBtn = resetForm.querySelector('.auth-submit');
            const password = document.getElementById('reset-password').value;
            const confirmPassword = document.getElementById('reset-confirm-password').value;

            if (password.length < 8) {
                showFeedback(feedback, 'Password must be at least 8 characters.');
                return;
            }
            if (password !== confirmPassword) {
                showFeedback(feedback, 'Passwords do not match.');
                return;
            }

            submitBtn.disabled = true;
            const originalText = submitBtn.textContent;
            submitBtn.textContent = 'Please wait…';

            try {
                const data = await Api.post('/auth/reset-password', { token: resetToken, password });
                showFeedback(feedback, `${data.message} Redirecting to sign in…`, true);
                setTimeout(() => {
                    window.location.href = 'login.html';
                }, 1500);
            } catch (err) {
                showFeedback(feedback, err.message);
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        });
    }

    /* ---------- Email verification (verify-email.html?token=...) ---------- */
    const verifyStatusEl = document.getElementById('verify-status');
    if (verifyStatusEl) {
        const urlParams = new URLSearchParams(window.location.search);
        const verifyToken = urlParams.get('token');

        if (!verifyToken) {
            verifyStatusEl.textContent = 'This verification link is missing its token.';
        } else {
            Api.get(`/auth/verify-email?token=${encodeURIComponent(verifyToken)}`)
                .then((data) => {
                    verifyStatusEl.textContent = data.message;
                    verifyStatusEl.style.color = '#8de08d';
                    const goToLoginBtn = document.getElementById('verify-go-to-login');
                    if (goToLoginBtn) goToLoginBtn.classList.remove('hidden');
                })
                .catch((err) => {
                    verifyStatusEl.textContent = err.message;
                    verifyStatusEl.style.color = '#ff9b9b';
                    const resendWrap = document.getElementById('verify-resend-wrap');
                    if (resendWrap) resendWrap.classList.remove('hidden');
                });
        }

        const resendForm = document.getElementById('form-verify-resend');
        if (resendForm) {
            resendForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                const email = document.getElementById('verify-resend-email').value.trim();
                if (!email) return;

                try {
                    const data = await Api.post('/auth/resend-verification', { email });
                    verifyStatusEl.textContent = data.message;
                    verifyStatusEl.style.color = '#8de08d';
                    resendForm.reset();
                } catch (err) {
                    verifyStatusEl.textContent = err.message;
                    verifyStatusEl.style.color = '#ff9b9b';
                }
            });
        }
    }
});

/**
 * Waits for the Google Identity Services script (loaded async in login.html)
 * to be ready, then renders the real "Sign in with Google" button and wires
 * its callback to handleGoogleCredentialResponse below.
 */
function initGoogleSignIn(container, attempt = 0) {
    if (typeof google === 'undefined' || !google.accounts || !google.accounts.id) {
        if (attempt > 40) return; // ~4s of retrying - the script likely failed to load (offline, blocked, etc); fail silently
        setTimeout(() => initGoogleSignIn(container, attempt + 1), 100);
        return;
    }

    google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleGoogleCredentialResponse,
    });

    google.accounts.id.renderButton(container, {
        theme: 'filled_black',
        size: 'large',
        shape: 'pill',
        width: 260,
        text: 'continue_with',
    });
}

/** Called by Google Identity Services once the person approves the sign-in popup. */
async function handleGoogleCredentialResponse(response) {
    const feedback = document.getElementById('login-feedback');

    try {
        const data = await Api.post('/auth/google', { credential: response.credential });
        Api.setToken(data.token, data.refreshToken);
        Api.setUserName(data.user.firstName);

        if (typeof Cart !== 'undefined') await Cart.mergeAfterLogin();
        if (typeof Wishlist !== 'undefined') await Wishlist.mergeAfterLogin();

        if (feedback) showFeedback(feedback, `Welcome, ${data.user.firstName}! Redirecting…`, true);
        setTimeout(() => {
            window.location.href = data.user.role === 'admin' ? 'admin/dashboard.html' : 'index.html';
        }, 600);
    } catch (err) {
        if (feedback) showFeedback(feedback, err.message);
    }
}

/**
 * Loads the Facebook JS SDK (once) and wires the Facebook button to open
 * Facebook's own login popup via FB.login().
 */
function initFacebookSignIn(button) {
    window.fbAsyncInit = function fbAsyncInit() {
        FB.init({
            appId: FACEBOOK_APP_ID,
            cookie: true,
            xfbml: false,
            version: 'v21.0',
        });
    };

    if (!document.getElementById('facebook-jssdk')) {
        const js = document.createElement('script');
        js.id = 'facebook-jssdk';
        js.src = 'https://connect.facebook.net/en_US/sdk.js';
        js.async = true;
        js.defer = true;
        document.body.appendChild(js);
    }

    button.addEventListener('click', () => {
        if (typeof FB === 'undefined') {
            alert('Facebook Login is still loading — please try again in a moment.');
            return;
        }

        // "email" is requested explicitly - without it Facebook may not
        // return an email address at all, which this app needs as the
        // account identifier (see handleFacebookLoginResponse below).
        FB.login(
            (response) => {
                if (response.authResponse) {
                    handleFacebookLoginResponse(response.authResponse);
                }
            },
            { scope: 'email' }
        );
    });
}

/** Called once the person approves the Facebook login popup. */
async function handleFacebookLoginResponse({ accessToken, userID }) {
    const feedback = document.getElementById('login-feedback');

    try {
        const data = await Api.post('/auth/facebook', { accessToken, userID });
        Api.setToken(data.token, data.refreshToken);
        Api.setUserName(data.user.firstName);

        if (typeof Cart !== 'undefined') await Cart.mergeAfterLogin();
        if (typeof Wishlist !== 'undefined') await Wishlist.mergeAfterLogin();

        if (feedback) showFeedback(feedback, `Welcome, ${data.user.firstName}! Redirecting…`, true);
        setTimeout(() => {
            window.location.href = data.user.role === 'admin' ? 'admin/dashboard.html' : 'index.html';
        }, 600);
    } catch (err) {
        if (feedback) showFeedback(feedback, err.message);
    }
}