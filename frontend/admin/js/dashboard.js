/* ==========================================================
   Shopinza Admin - dashboard.js
   Fetches GET /api/admin/stats + GET /api/admin/analytics and
   renders the overview: stat cards, revenue/top-product/
   category charts (Chart.js), a low-stock list, and the
   recent orders table.
   ========================================================== */

const CHART_COLORS = {
    purple: '#c4c1fb',
    green: '#4ade80',
    orange: '#f5a94a',
    blue: '#60a5fa',
    red: '#f87171',
    pink: '#f472b6',
    grid: '#262a37',
    text: '#9a9aa5',
};
const CHART_PALETTE = [CHART_COLORS.purple, CHART_COLORS.green, CHART_COLORS.orange, CHART_COLORS.blue, CHART_COLORS.red, CHART_COLORS.pink];

document.addEventListener('DOMContentLoaded', async () => {
    const admin = await AdminGuard.verify();
    if (!admin) return;

    AdminGuard.renderSidebar('dashboard');

    const container = document.getElementById('dashboard-content');

    try {
        const [stats, analytics] = await Promise.all([
            Api.get('/admin/stats', { auth: true }),
            Api.get('/admin/analytics?days=30&lowStockThreshold=5', { auth: true }),
        ]);

        container.innerHTML = renderDashboard(stats, analytics);
        renderCharts(analytics);
    } catch (err) {
        container.innerHTML = `<p class="loading-note">Could not load stats: ${err.message}</p>`;
    }
});

function renderDashboard(stats, analytics) {
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
            <h2>Revenue - Last 30 Days</h2>
            <div class="chart-wrap chart-wrap-tall">
                <canvas id="revenue-chart"></canvas>
            </div>
        </div>

        <div class="chart-grid-2col">
            <div class="admin-panel">
                <h2>Top-Selling Products</h2>
                <div class="chart-wrap">
                    ${analytics.topProducts.length === 0 ? renderChartEmptyState('No sales yet.') : '<canvas id="top-products-chart"></canvas>'}
                </div>
            </div>
            <div class="admin-panel">
                <h2>Sales by Category</h2>
                <div class="chart-wrap">
                    ${analytics.salesByCategory.length === 0 ? renderChartEmptyState('No sales yet.') : '<canvas id="category-chart"></canvas>'}
                </div>
            </div>
        </div>

        <div class="admin-panel">
            <h2>Low Stock Alerts <span class="low-stock-count">${analytics.lowStock.length}</span></h2>
            <div class="admin-table-wrap">
                ${renderLowStockTable(analytics.lowStock, analytics.lowStockThreshold)}
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

function renderChartEmptyState(message) {
    return `<div class="empty-state"><span class="material-symbols-outlined">bar_chart</span><p>${message}</p></div>`;
}

function renderLowStockTable(products, threshold) {
    if (!products || products.length === 0) {
        return `<div class="empty-state"><span class="material-symbols-outlined">check_circle</span><p>All products are well stocked (above ${threshold} units).</p></div>`;
    }

    const rows = products
        .map(
            (p) => `
        <tr>
            <td><img src="${p.image}" alt="${p.name}" class="thumb" /></td>
            <td>${p.name}</td>
            <td>${p.category || '—'}</td>
            <td><span class="status-badge ${p.stock === 0 ? 'status-cancelled' : 'status-pending'}">${p.stock} left</span></td>
        </tr>`
        )
        .join('');

    return `
        <table class="admin-table">
            <thead>
                <tr><th></th><th>Product</th><th>Category</th><th>Stock</th></tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

// customer-controlled text (guest checkout names etc.) must never be inserted as raw HTML in the admin panel
function dashEscape(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
            <td>${dashEscape(order.shipping.firstName)} ${dashEscape(order.shipping.lastName)}</td>
            <td>${order.items.length} item${order.items.length === 1 ? '' : 's'}</td>
            <td>$${order.total.toFixed(2)}</td>
            <td><span class="status-badge status-${dashEscape(order.status)}">${dashEscape(order.status)}</span></td>
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

/** Instantiates the three Chart.js charts once their <canvas> elements exist in the DOM. */
function renderCharts(analytics) {
    Chart.defaults.color = CHART_COLORS.text;
    Chart.defaults.font.family = "'Inter', sans-serif";

    // ---------- Revenue over time (line chart) ----------
    const revenueCanvas = document.getElementById('revenue-chart');
    if (revenueCanvas) {
        new Chart(revenueCanvas, {
            type: 'line',
            data: {
                labels: analytics.revenueByDay.map((d) =>
                    new Date(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                ),
                datasets: [
                    {
                        label: 'Revenue',
                        data: analytics.revenueByDay.map((d) => d.revenue),
                        borderColor: CHART_COLORS.purple,
                        backgroundColor: 'rgba(196, 193, 251, 0.15)',
                        fill: true,
                        tension: 0.3,
                        pointRadius: 0,
                        borderWidth: 2,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { color: CHART_COLORS.grid }, ticks: { maxTicksLimit: 8 } },
                    y: { grid: { color: CHART_COLORS.grid }, ticks: { callback: (v) => `$${v}` }, beginAtZero: true },
                },
            },
        });
    }

    // ---------- Top-selling products (horizontal bar) ----------
    const topProductsCanvas = document.getElementById('top-products-chart');
    if (topProductsCanvas) {
        new Chart(topProductsCanvas, {
            type: 'bar',
            data: {
                labels: analytics.topProducts.map((p) => p.name),
                datasets: [
                    {
                        label: 'Units sold',
                        data: analytics.topProducts.map((p) => p.qty),
                        backgroundColor: CHART_COLORS.purple,
                        borderRadius: 6,
                    },
                ],
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { color: CHART_COLORS.grid }, beginAtZero: true, ticks: { precision: 0 } },
                    y: { grid: { display: false } },
                },
            },
        });
    }

    // ---------- Sales by category (doughnut) ----------
    const categoryCanvas = document.getElementById('category-chart');
    if (categoryCanvas) {
        new Chart(categoryCanvas, {
            type: 'doughnut',
            data: {
                labels: analytics.salesByCategory.map((c) => c.category),
                datasets: [
                    {
                        data: analytics.salesByCategory.map((c) => c.revenue),
                        backgroundColor: CHART_PALETTE,
                        borderColor: '#1e222e',
                        borderWidth: 2,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12 } } },
            },
        });
    }
}
