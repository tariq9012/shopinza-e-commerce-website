/* ==========================================================
   Shopinza Admin - admin-guard.js
   Runs on every admin page BEFORE the page's own script.
   Verifies the person is signed in AND has the "admin" role
   (calls GET /api/auth/me). Redirects to the login page if not.
   Also renders the shared sidebar with the correct active link.
   Depends on ../js/config.js (Api) being loaded first.
   ========================================================== */

const AdminGuard = {
    currentAdmin: null,

    async verify() {
        if (!Api.isLoggedIn()) {
            this.redirectToLogin();
            return null;
        }

        try {
            const data = await Api.get('/auth/me', { auth: true });

            if (data.user.role !== 'admin') {
                this.showAccessDenied();
                return null;
            }

            this.currentAdmin = data.user;
            return data.user;
        } catch (err) {
            this.redirectToLogin();
            return null;
        }
    },

    redirectToLogin() {
        window.location.href = '../login.html';
    },

    showAccessDenied() {
        document.body.innerHTML = `
            <div class="access-denied">
                <span class="material-symbols-outlined">block</span>
                <h1>Admin access only</h1>
                <p style="color:#9a9aa5;">Your account doesn't have admin permissions.</p>
                <a href="../index.html"><button class="btn-admin-primary" style="margin-top:12px;">Back to Shopinza</button></a>
            </div>
        `;
    },

    renderSidebar(activePage) {
        const pages = [
            { id: 'dashboard', href: 'dashboard.html', icon: 'dashboard', label: 'Dashboard' },
            { id: 'products', href: 'products.html', icon: 'inventory_2', label: 'Products' },
            { id: 'orders', href: 'orders.html', icon: 'receipt_long', label: 'Orders' },
            { id: 'messages', href: 'messages.html', icon: 'mail', label: 'Messages' },
        ];

        const navHtml = pages
            .map(
                (p) => `
                <a href="${p.href}" class="${p.id === activePage ? 'active' : ''}">
                    <span class="material-symbols-outlined">${p.icon}</span> ${p.label}
                </a>
            `
            )
            .join('');

        const sidebar = document.createElement('aside');
        sidebar.className = 'admin-sidebar';
        sidebar.innerHTML = `
            <div class="admin-logo">Shopinza Admin</div>
            <nav class="admin-nav">${navHtml}</nav>
            <div class="admin-sidebar-footer">
                <a href="../index.html" class="admin-back-link">
                    <span class="material-symbols-outlined">arrow_back</span> Back to Store
                </a>
                <a href="#" class="admin-back-link js-admin-logout">
                    <span class="material-symbols-outlined">logout</span> Sign Out
                </a>
            </div>
        `;

        const shell = document.querySelector('.admin-shell');
        if (shell) shell.prepend(sidebar);

        const logoutBtn = sidebar.querySelector('.js-admin-logout');
        logoutBtn.addEventListener('click', (event) => {
            event.preventDefault();
            if (confirm('Sign out of the admin dashboard?')) {
                Api.clearToken();
                window.location.href = '../login.html';
            }
        });
    },
};
