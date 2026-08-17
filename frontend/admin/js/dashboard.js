/* ==========================================================
   Shopinza Admin - dashboard.js
   Fetches GET /api/admin/stats and renders the overview.
   ========================================================== */

document.addEventListener('DOMContentLoaded', async () => {
    const admin = await AdminGuard.verify();
    if (!admin) return;

    AdminGuard.renderSidebar('dashboard');

    const container = document.getElementById('dashboard-content');

    try {
        const stats = await Api.get('/admin/stats', { auth: true });
        container.innerHTML = renderDashboard(stats);
    } catch (err) {
        container.innerHTML = `<p class="loading-note">Could not load stats: ${err.message}</p>`;
    }
});

function renderDashboard(stats) {
    return `
        <div class="stat-grid">
            <div class="stat-card">
                <div class="stat-label"><span class="material-symbols-outlined">payments</span> Total Revenue</div>
                <div class="stat-value">$${stats.totalRevenue.toFixed(2)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label"><span class="material-symbols-outlined">receipt_long</span> Total Orders</div>
                <div class="stat-value">${stats.totalOrders}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label"><span class="material-symbols-outlined">inventory_2</span> Products</div>
                <div class="stat-value">${stats.totalProducts}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label"><span class="material-symbols-outlined">group</span> Registered Users</div>
                <div class="stat-value">${stats.totalUsers}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label"><span class="material-symbols-outlined">pending_actions</span> Pending Orders</div>
                <div class="stat-value">${stats.pendingOrders}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label"><span class="material-symbols-outlined">mail</span> Unread Messages</div>
                <div class="stat-value">${stats.unresolvedMessages}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label"><span class="material-symbols-outlined">campaign</span> Newsletter Subscribers</div>
                <div class="stat-value">${stats.totalSubscribers}</div>
            </div>
        </div>

        <div class="admin-panel">
            <h2>Recent Orders</h2>
            <div class="admin-table-wrap">
                ${renderRecentOrdersTable(stats.recentOrders)}
            </div>
        </div>
    `;
}

function renderRecentOrdersTable(orders) {
    if (!orders || orders.length === 0) {
        return `<div class="empty-state"><span class="material-symbols-outlined">inbox</span><p>No orders yet.</p></div>`;
    }

    const rows = orders
        .map(
            (order) => `
        <tr>
            <td>#${order._id.slice(-6).toUpperCase()}</td>
            <td>${order.shipping.firstName} ${order.shipping.lastName}</td>
            <td>${order.items.length} item${order.items.length === 1 ? '' : 's'}</td>
            <td>$${order.total.toFixed(2)}</td>
            <td><span class="status-badge status-${order.status}">${order.status}</span></td>
            <td>${new Date(order.createdAt).toLocaleDateString()}</td>
        </tr>
    `
        )
        .join('');

    return `
        <table class="admin-table">
            <thead>
                <tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th><th>Date</th></tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}
