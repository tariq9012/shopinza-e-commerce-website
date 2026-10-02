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

    // "View" button opens a modal with the full shipping address + phone,
    // so the admin has what they need to actually ship the order.
    document.getElementById('orders-table-wrap').addEventListener('click', (event) => {
        const btn = event.target.closest('.js-view-order');
        if (!btn) return;
        const order = ordersCache.find((o) => o._id === btn.dataset.id);
        if (order) openOrderModal(order);
    });

    // "Refund" button: the only way an ONLINE-paid order gets cancelled. Stripe is refunded automatically;
    // JazzCash/Easypaisa must be refunded in the provider's portal first, then the reference is recorded here.
    document.getElementById('orders-table-wrap').addEventListener('click', async (event) => {
        const btn = event.target.closest('.js-refund-order');
        if (!btn) return;
        const order = ordersCache.find((o) => o._id === btn.dataset.id);
        if (!order) return;

        const body = {};
        if (order.paymentMethod === 'stripe') {
            if (!confirm(`Refund $${order.total.toFixed(2)} to the customer's card via Stripe and cancel this order? This cannot be undone.`)) return;
        } else {
            const ref = prompt(
                `Automated refunds are not available for ${order.paymentMethod}.\n\n1) Refund the customer in the provider's merchant portal.\n2) Enter the refund reference number below to record it and cancel the order.\n\n(Leave empty to just flag the order as "manual refund required".)`
            );
            if (ref === null) return;
            if (ref.trim()) body.manualReference = ref.trim();
        }

        btn.disabled = true;
        try {
            await Api.request(`/orders/admin/${order._id}/refund`, { method: 'POST', body, auth: true });
            alert('Done. The order has been refunded and cancelled.');
        } catch (err) {
            alert(err.message);
        }
        await loadOrders();
    });

    document.getElementById('order-view-overlay').addEventListener('click', (event) => {
        if (event.target.id === 'order-view-overlay') closeOrderModal();
    });
    document.getElementById('order-view-close').addEventListener('click', closeOrderModal);
});

let ordersCache = [];

function openOrderModal(order) {
    const s = order.shipping || {};
    document.getElementById('order-view-body').innerHTML = `
        <p><strong>Order:</strong> #${order._id.slice(-6).toUpperCase()}</p>
        <p><strong>Name:</strong> ${escapeHtml(s.firstName)} ${escapeHtml(s.lastName)}</p>
        <p><strong>Email:</strong> ${escapeHtml(s.email) || '—'}</p>
        <p><strong>Phone:</strong> ${escapeHtml(s.phone) || '—'}</p>
        <p><strong>Address:</strong> ${escapeHtml(s.address)}</p>
        <p><strong>City / State:</strong> ${escapeHtml(s.city)}, ${escapeHtml(s.state)}</p>
        <p><strong>ZIP:</strong> ${escapeHtml(s.zip)}</p>
        <p><strong>Shipping Method:</strong> ${escapeHtml(order.shippingMethod)}</p>
        <p><strong>Payment Method:</strong> ${PAYMENT_LABELS[order.paymentMethod || 'cod'] || order.paymentMethod}</p>
        <hr style="border-color:#262a37; margin:16px 0;">
        <p><strong>Items:</strong></p>
        <ul style="margin-left:18px;">
            ${order.items.map((it) => `<li>${escapeHtml(it.name)}${it.color && it.size ? ` (${escapeHtml(it.color)} / ${escapeHtml(it.size)})` : ''} × ${it.qty} — $${it.price.toFixed(2)}</li>`).join('')}
        </ul>
        <p style="margin-top:12px;"><strong>Total:</strong> $${order.total.toFixed(2)}</p>
    `;
    document.getElementById('order-view-overlay').style.display = 'flex';
}

function closeOrderModal() {
    document.getElementById('order-view-overlay').style.display = 'none';
}

async function loadOrders() {
    const wrap = document.getElementById('orders-table-wrap');
    const statusFilter = document.getElementById('status-filter').value;

    try {
        const query = statusFilter ? `?status=${statusFilter}` : '';
        const data = await Api.get(`/orders/admin/all${query}`, { auth: true });
        ordersCache = data.orders || [];
        wrap.innerHTML = renderOrdersTable(data.orders);
    } catch (err) {
        wrap.innerHTML = `<p class="loading-note">Could not load orders: ${err.message}</p>`;
    }
}

const STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];

const PAYMENT_LABELS = {
    cod: 'COD',
    stripe: 'Card',
    jazzcash: 'JazzCash',
    easypaisa: 'Easypaisa',
};

function renderOrdersTable(orders) {
    if (!orders || orders.length === 0) {
        return `<div class="empty-state"><span class="material-symbols-outlined">receipt_long</span><p>No orders found.</p></div>`;
    }

    const rows = orders
        .map((order) => {
            const options = STATUSES.map(
                (s) => `<option value="${s}" ${s === order.status ? 'selected' : ''}>${s}</option>`
            ).join('');

            const paymentMethod = order.paymentMethod || 'cod';
            const paymentLabel = PAYMENT_LABELS[paymentMethod] || paymentMethod;

            // online-paid orders are cancelled through Refund (never just flipped to "cancelled")
            const onlinePaid = order.status === 'paid' && paymentMethod !== 'cod';
            const lateNeedsRefund = order.status === 'cancelled' && order.paymentIssue && !['succeeded', 'manual_done'].includes(order.refundStatus);
            const refundButton =
                onlinePaid || lateNeedsRefund
                    ? `<button type="button" class="js-refund-order" data-id="${order._id}" style="background:#5a2a2a; color:#ffb4b4; border:1px solid #7a3a3a; border-radius:6px; padding:6px 10px; cursor:pointer; font-size:12px; margin-left:6px;">${lateNeedsRefund ? 'Refund late payment' : 'Refund &amp; cancel'}</button>`
                    : '';
            const refundNote =
                (order.refundStatus && order.refundStatus !== 'none' ? `<br><span style="color:#9a9aa5; font-size:11px;">refund: ${escapeHtml(order.refundStatus)}</span>` : '') +
                (order.paymentIssue ? `<br><span style="color:#ffb4b4; font-size:11px;" title="${escapeHtml(order.paymentIssue)}">&#9888; payment issue - reconcile</span>` : '');

            return `
        <tr>
            <td>#${order._id.slice(-6).toUpperCase()}</td>
            <td>${escapeHtml(order.shipping.firstName)} ${escapeHtml(order.shipping.lastName)}<br><span style="color:#9a9aa5; font-size:12px;">${escapeHtml(order.shipping.city)}, ${escapeHtml(order.shipping.state)}</span></td>
            <td>${order.items.length} item${order.items.length === 1 ? '' : 's'}</td>
            <td>$${order.total.toFixed(2)}</td>
            <td><span class="status-badge payment-${paymentMethod}">${paymentLabel}</span></td>
            <td>${order.shippingMethod}</td>
            <td><select class="admin-select js-status-select status-${order.status}" data-id="${order._id}">${options}</select>${refundNote}</td>
            <td>${new Date(order.createdAt).toLocaleDateString()}</td>
            <td><button type="button" class="js-view-order" data-id="${order._id}" style="background:#2a2f3d; color:#f5f5f7; border:1px solid #3a3f4d; border-radius:6px; padding:6px 10px; cursor:pointer; font-size:12px;">View</button>${refundButton}</td>
        </tr>
    `;
        })
        .join('');

    return `
        <table class="admin-table">
            <thead>
                <tr><th>Order</th><th>Customer</th><th>Items</th><th>Total</th><th>Payment</th><th>Shipping</th><th>Status</th><th>Date</th><th>Details</th></tr>
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
