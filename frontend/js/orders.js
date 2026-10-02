/* ==========================================================
   Shopinza - orders.js
   "My Orders" page for a signed-in customer: lists every past
   order (GET /api/orders/mine) with status, items, and total.
   Depends on config.js.
   ========================================================== */

function formatMoney(amount) {
    return `$${Number(amount).toFixed(2)}`;
}

function formatOrderDate(dateString) {
    return new Date(dateString).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
}

/** Human-friendly label + description for each status, shown at the top of an order card. */
const STATUS_LABELS = {
    pending: 'Pending',
    paid: 'Paid',
    shipped: 'Shipped',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
};

// A customer can self-cancel only an UNPAID order. A paid order needs support + a real refund,
// so it is never cancelled from here (the server refuses it too).
const CANCELLABLE_STATUSES = ['pending'];

function orderEsc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderOrderCard(order) {
    const previewItems = order.items.slice(0, 4);
    const extraCount = order.items.length - previewItems.length;

    const itemsPreviewHtml =
        previewItems.map((item) => `<img src="${orderEsc(item.image || '')}" alt="${orderEsc(item.name)}" title="${orderEsc(item.name)} × ${Number(item.qty)}" />`).join('') +
        (extraCount > 0 ? `<div class="more-count">+${extraCount}</div>` : '');

    const canCancel = CANCELLABLE_STATUSES.includes(order.status);
    const paidNeedsSupport = order.status === 'paid' && order.paymentMethod !== 'cod';

    return `
        <div class="order-card" data-order-id="${order._id}">
            <div class="order-card-header">
                <div class="meta">
                    <div>Order # <strong>${String(order._id).slice(-6).toUpperCase()}</strong></div>
                    <div>Placed on <strong>${formatOrderDate(order.createdAt)}</strong></div>
                    <div>Payment <strong style="text-transform:capitalize;">${order.paymentMethod === 'cod' ? 'Cash on Delivery' : orderEsc(order.paymentMethod)}</strong></div>
                </div>
                <span class="order-status-badge ${orderEsc(order.status)}">${orderEsc(STATUS_LABELS[order.status] || order.status)}</span>
            </div>
            <div class="order-card-body">
                <div class="order-items-preview">${itemsPreviewHtml}</div>
                <div class="order-card-footer">
                    <span class="total">Total: ${formatMoney(order.total)}</span>
                    <div class="order-card-actions">
                        ${canCancel ? `<button type="button" class="cancel-btn js-cancel-order" data-id="${order._id}">Cancel Order</button>` : ''}
                        ${paidNeedsSupport ? `<span style="font-size:12px; color:#9a9aa5;">Paid - contact support to cancel and get a refund</span>` : ''}
                        <a href="order-confirmation.html?orderId=${order._id}">View Details</a>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function renderSignInPrompt() {
    return `
        <div class="orders-empty-state">
            <span class="material-symbols-outlined">lock</span>
            <p>Please sign in to see your order history.</p>
            <a href="login.html" class="btn-primary" style="display:inline-block; margin-top:12px; text-decoration:none;">Sign In</a>
        </div>
    `;
}

function renderEmptyState(statusFilter) {
    if (statusFilter === 'cancelled') {
        return `
            <div class="orders-empty-state">
                <span class="material-symbols-outlined">block</span>
                <p>You don't have any cancelled orders.</p>
            </div>
        `;
    }

    return `
        <div class="orders-empty-state">
            <span class="material-symbols-outlined">receipt_long</span>
            <p>You haven't placed any orders yet.</p>
            <a href="shop.html" class="btn-primary" style="display:inline-block; margin-top:12px; text-decoration:none;">Start Shopping</a>
        </div>
    `;
}

function renderErrorState(message) {
    return `<div class="orders-empty-state"><span class="material-symbols-outlined">error</span><p>${message}</p></div>`;
}

document.addEventListener('DOMContentLoaded', async () => {
    const wrap = document.getElementById('orders-list');
    if (!wrap) return;

    if (!Api.isLoggedIn()) {
        wrap.innerHTML = renderSignInPrompt();
        return;
    }

    await loadOrders();

    // ---------- Live status updates (no refresh needed) ----------
    // Whenever an admin changes any of these orders' status, the server
    // pushes it straight here (see backend/socket.js) and the matching
    // card's badge/actions update in place.
    if (typeof AppSocket !== 'undefined') {
        AppSocket.onOrderUpdate((payload) => {
            const card = wrap.querySelector(`[data-order-id="${payload.orderId}"]`);
            if (!card) return; // not an order shown on this page (or filtered out on cancellations.html)

            const badge = card.querySelector('.order-status-badge');
            if (badge) {
                badge.className = `order-status-badge ${payload.status}`;
                badge.textContent = STATUS_LABELS[payload.status] || payload.status;
            }

            const actionsWrap = card.querySelector('.order-card-actions');
            const existingCancelBtn = card.querySelector('.js-cancel-order');
            const stillCancellable = CANCELLABLE_STATUSES.includes(payload.status);
            if (!stillCancellable && existingCancelBtn) {
                existingCancelBtn.remove(); // e.g. order just got marked "shipped" - can't self-cancel anymore
            } else if (stillCancellable && !existingCancelBtn && actionsWrap) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'cancel-btn js-cancel-order';
                btn.dataset.id = payload.orderId;
                btn.textContent = 'Cancel Order';
                actionsWrap.insertBefore(btn, actionsWrap.firstChild);
            }
        });
    }

    wrap.addEventListener('click', async (event) => {
        const btn = event.target.closest('.js-cancel-order');
        if (!btn) return;

        if (!confirm('Cancel this order? This cannot be undone.')) return;

        btn.disabled = true;
        btn.textContent = 'Cancelling…';

        try {
            await Api.request(`/orders/${btn.dataset.id}/cancel`, { method: 'PATCH', auth: true });
            await loadOrders(); // refresh the list so the status badge/actions update
        } catch (err) {
            alert(err.message || 'Could not cancel this order.');
            btn.disabled = false;
            btn.textContent = 'Cancel Order';
        }
    });
});

// The same script backs both orders.html (all orders) and
// cancellations.html (cancelled orders only) - the page sets
// data-status-filter="cancelled" on #orders-list to opt into filtering.
async function loadOrders() {
    const wrap = document.getElementById('orders-list');
    const statusFilter = wrap.dataset.statusFilter;

    try {
        const data = await Api.get('/orders/mine', { auth: true });
        let orders = data.orders || [];

        if (statusFilter) {
            orders = orders.filter((order) => order.status === statusFilter);
        }

        if (orders.length === 0) {
            wrap.innerHTML = renderEmptyState(statusFilter);
            return;
        }

        wrap.innerHTML = orders.map((order) => renderOrderCard(order)).join('');

        // join a room per visible order so live status pushes reach this page (see the listener above)
        if (typeof AppSocket !== 'undefined') {
            orders.forEach((order) => AppSocket.joinOrder(order._id));
        }
    } catch (err) {
        wrap.innerHTML = renderErrorState(err.message || 'Could not load your orders.');
    }
}
