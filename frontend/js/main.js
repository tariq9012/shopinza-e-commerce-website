/* ==========================================================
   Shopinza - main.js
   Shared across all light-theme pages (Home, Shop, Categories,
   About, Contact, Product Details).
   Handles: mobile hamburger menu toggle.
   ========================================================== */

document.addEventListener('DOMContentLoaded', () => {
    const menuToggleBtn = document.getElementById('menu-toggle-btn');
    const navLinkList = document.getElementById('nav-link-list');

    if (!menuToggleBtn || !navLinkList) return;

    menuToggleBtn.addEventListener('click', () => {
        navLinkList.classList.toggle('mobile-open');

        const isOpen = navLinkList.classList.contains('mobile-open');
        const icon = menuToggleBtn.querySelector('.material-symbols-outlined');
        if (icon) {
            icon.textContent = isOpen ? 'close' : 'menu';
        }
    });

    // close the mobile menu if a link inside it is clicked
    navLinkList.querySelectorAll('a').forEach((link) => {
        link.addEventListener('click', () => {
            navLinkList.classList.remove('mobile-open');
            const icon = menuToggleBtn.querySelector('.material-symbols-outlined');
            if (icon) icon.textContent = 'menu';
        });
    });

    // close the mobile menu if the person clicks outside of it
    document.addEventListener('click', (event) => {
        const clickedInsideMenu = navLinkList.contains(event.target);
        const clickedToggleBtn = menuToggleBtn.contains(event.target);
        if (!clickedInsideMenu && !clickedToggleBtn) {
            navLinkList.classList.remove('mobile-open');
            const icon = menuToggleBtn.querySelector('.material-symbols-outlined');
            if (icon) icon.textContent = 'menu';
        }
    });
});

/* ---------- Account icon: go to login, or sign out if already signed in ---------- */
document.addEventListener('DOMContentLoaded', () => {
    if (typeof Api === 'undefined') return; // config.js not loaded on this page

    const accountButtons = document.querySelectorAll('.icon-btn .material-symbols-outlined');
    accountButtons.forEach((icon) => {
        if (icon.textContent.trim() !== 'person') return;
        const button = icon.closest('button');
        if (!button) return;

        if (Api.isLoggedIn()) {
            icon.textContent = 'logout';
            button.setAttribute('title', 'Sign out');
        } else {
            button.setAttribute('title', 'Sign in');
        }

        button.addEventListener('click', () => {
            if (Api.isLoggedIn()) {
                if (confirm('Sign out of Shopinza?')) {
                    Api.clearToken();
                    window.location.reload();
                }
            } else {
                window.location.href = 'login.html';
            }
        });
    });
});
