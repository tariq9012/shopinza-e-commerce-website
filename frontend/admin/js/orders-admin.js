/* ==========================================================
   Shopinza Admin - orders-admin.js
   Lists orders (GET /api/orders/admin/all) and lets the admin
   change each order's status (PATCH /api/orders/admin/:id/status).
   ========================================================== */

document.addEventListener('DOMContentLoaded', async () => {
    const admin = await AdminGuard.verify();
    if (!admin) return;

    AdminGuard.renderSidebar('orders');

    await loadOrders();

    document.getElementById('status-filter').addEventListener('change', loadOrders);

    document.getElementById('orders-table-wrap').addEventListener('change', async (event) => {
        const select = event.target.closest('.js-status-select');
        if (!select) return;

        const orderId = select.dataset.id;
        const newStatus = select.value;

        try {
            await Api.request(`/orders/admin/${orderId}/status`, {
                method: 'PATCH',
                body: { status: newStatus },
                auth: true,
            });
            select.className = `admin-select js-status-select status-${newStatus}`;
        } catch (err) {
            alert(err.message);
            await loadOrders();
        }
    });
});

async function loadOrders() {
    const wrap = document.getElementById('orders-table-wrap');
    const statusFilter = document.getElementById('status-filter').value;

    try {
        const query = statusFilter ? `?status=${statusFilter}` : '';
        const data = await Api.get(`/orders/admin/all${query}`, { auth: true });
        wrap.innerHTML = renderOrdersTable(data.orders);
    } catch (err) {
        wrap.innerHTML = `<p class="loading-note">Could not load orders: ${err.message}</p>`;
    }
}

const STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];

function renderOrdersTable(orders) {
    if (!orders || orders.length === 0) {
        return `<div class="empty-state"><span class="material-symbols-outlined">receipt_long</span><p>No orders found.</p></div>`;
    }

    const rows = orders
        .map((order) => {
            const options = STATUSES.map(
                (s) => `<option value="${s}" ${s === order.status ? 'selected' : ''}>${s}</option>`
            ).join('');

            return `
        <tr>
            <td>#${order._id.slice(-6).toUpperCase()}</td>
            <td>${escapeHtml(order.shipping.firstName)} ${escapeHtml(order.shipping.lastName)}<br><span style="color:#9a9aa5; font-size:12px;">${escapeHtml(order.shipping.city)}, ${escapeHtml(order.shipping.state)}</span></td>
            <td>${order.items.length} item${order.items.length === 1 ? '' : 's'}</td>
            <td>$${order.total.toFixed(2)}</td>
            <td>${order.shippingMethod}</td>
            <td><select class="admin-select js-status-select status-${order.status}" data-id="${order._id}">${options}</select></td>
            <td>${new Date(order.createdAt).toLocaleDateString()}</td>
        </tr>
    `;
        })
        .join('');

    return `
        <table class="admin-table">
            <thead>
                <tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Shipping</th><th>Status</th><th>Date</th></tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}
