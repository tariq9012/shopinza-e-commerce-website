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
            button.setAttribute('title', 'My Account');
            showAccountName(button, icon);
        } else {
            button.setAttribute('title', 'Sign in');
        }

        button.addEventListener('click', () => {
            if (!Api.isLoggedIn()) {
                window.location.href = 'login.html';
                return;
            }

            // already open? toggle it closed
            const existingMenu = button.parentElement.querySelector('.js-account-menu');
            if (existingMenu) {
                existingMenu.remove();
                return;
            }

            const menu = document.createElement('div');
            menu.className = 'js-account-menu';
            menu.style.cssText =
                'position:absolute; margin-top:44px; background:#fff; border:1px solid #e5e5ea; border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,0.12); overflow:hidden; z-index:50; min-width:160px;';
            menu.innerHTML = `
                <a href="orders.html" style="display:block; padding:10px 16px; color:#131b2e; text-decoration:none; font-size:14px;">My Orders</a>
                <a href="cancellations.html" style="display:block; padding:10px 16px; color:#131b2e; text-decoration:none; font-size:14px;">Cancellations</a>
                <a href="wishlist.html" style="display:block; padding:10px 16px; color:#131b2e; text-decoration:none; font-size:14px;">My Wishlist</a>
                <button type="button" class="js-account-signout" style="display:block; width:100%; text-align:left; padding:10px 16px; background:none; border:none; color:#c1272d; font-size:14px; cursor:pointer; border-top:1px solid #e5e5ea;">Sign Out</button>
            `;

            button.style.position = 'relative';
            button.parentElement.style.position = 'relative';
            button.insertAdjacentElement('afterend', menu);

            menu.querySelector('.js-account-signout').addEventListener('click', () => {
                Api.clearToken();
                window.location.reload();
            });

            // close the menu if the person clicks anywhere else
            setTimeout(() => {
                document.addEventListener(
                    'click',
                    function closeMenu(event) {
                        if (!menu.contains(event.target) && event.target !== button) {
                            menu.remove();
                            document.removeEventListener('click', closeMenu);
                        }
                    },
                    { once: false }
                );
            }, 0);
        });
    });
});

/**
 * Replaces the account icon with the signed-in customer's first name.
 * The name is cached in localStorage at login time (see Api.setUserName in
 * auth.js) so this is instant on every page load - no extra API call. Only
 * an old session from before this feature existed (no cached name yet)
 * falls back to fetching it once from /auth/me.
 */
function showAccountName(button, icon) {
    const cachedName = Api.getUserName();
    if (cachedName) {
        renderAccountName(button, icon, cachedName);
        return;
    }

    Api.get('/auth/me', { auth: true })
        .then((data) => {
            Api.setUserName(data.user.firstName);
            renderAccountName(button, icon, data.user.firstName);
        })
        .catch(() => {}); // token might be stale - leave the icon showing as a harmless fallback
}

function renderAccountName(button, icon, name) {
    icon.style.display = 'none';
    button.classList.add('account-name-btn');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'js-account-name';
    nameSpan.textContent = name;
    icon.insertAdjacentElement('afterend', nameSpan);
}

/* ---------- Search icon: expand into an inline search box, go to Shop with results ---------- */
document.addEventListener('DOMContentLoaded', () => {
    const searchButtons = document.querySelectorAll('.icon-btn .material-symbols-outlined');

    searchButtons.forEach((icon) => {
        if (icon.textContent.trim() !== 'search') return;
        const button = icon.closest('button');
        if (!button || button.dataset.searchWired) return;
        button.dataset.searchWired = 'true';

        button.setAttribute('title', 'Search products');

        button.addEventListener('click', () => {
            // already expanded? just focus it again
            const existingInput = button.parentElement.querySelector('.js-navbar-search-input');
            if (existingInput) {
                existingInput.focus();
                return;
            }

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'Search products…';
            input.className = 'js-navbar-search-input';
            input.style.cssText =
                'border:none; outline:none; background:#f2f3ff; border-radius:8px; padding:8px 12px; font-size:14px; color:#131b2e; width:180px; margin-right:8px;';

            button.insertAdjacentElement('beforebegin', input);
            input.focus();

            const goToShop = () => {
                const value = input.value.trim();
                if (value) {
                    window.location.href = `shop.html?q=${encodeURIComponent(value)}`;
                }
            };

            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') goToShop();
                if (event.key === 'Escape') input.remove();
            });

            // collapse the box again if the user clicks elsewhere without searching
            input.addEventListener('blur', () => {
                setTimeout(() => {
                    if (document.activeElement !== input) input.remove();
                }, 150);
            });
        });
    });
});
