/* ==========================================================
   Shopinza Admin - coupons-admin.js
   Lists coupons and wires the add/edit modal
   (POST/PATCH /api/coupons/admin) and delete
   (DELETE /api/coupons/admin/:id).
   ========================================================== */

let couponsCache = [];

document.addEventListener('DOMContentLoaded', async () => {
    const admin = await AdminGuard.verify();
    if (!admin) return;

    AdminGuard.renderSidebar('coupons');

    await loadCoupons();

    const overlay = document.getElementById('coupon-modal-overlay');
    const form = document.getElementById('coupon-form');
    const modalTitle = document.getElementById('coupon-modal-title');
    const feedback = document.getElementById('coupon-form-feedback');

    document.getElementById('add-coupon-btn').addEventListener('click', () => openModal());
    document.getElementById('coupon-cancel-btn').addEventListener('click', () => closeModal());
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeModal();
    });

    function openModal(coupon) {
        form.reset();
        feedback.classList.add('hidden');
        document.getElementById('coupon-id').value = coupon ? coupon._id : '';
        modalTitle.textContent = coupon ? 'Edit Coupon' : 'New Coupon';

        const codeInput = document.getElementById('coupon-code');
        codeInput.value = coupon ? coupon.code : '';
        codeInput.disabled = Boolean(coupon); // code can't be changed once created - keeps existing usage history meaningful

        document.getElementById('coupon-type').value = coupon ? coupon.type : 'percent';
        document.getElementById('coupon-value').value = coupon ? coupon.value : '';
        document.getElementById('coupon-max-discount').value = coupon && coupon.maxDiscount != null ? coupon.maxDiscount : '';
        document.getElementById('coupon-min-order').value = coupon ? coupon.minOrderValue : 0;
        document.getElementById('coupon-usage-limit').value = coupon && coupon.usageLimit != null ? coupon.usageLimit : '';
        document.getElementById('coupon-expires').value = coupon && coupon.expiresAt ? coupon.expiresAt.slice(0, 10) : '';
        document.getElementById('coupon-active').checked = coupon ? coupon.active : true;

        overlay.classList.remove('hidden');
    }

    function closeModal() {
        overlay.classList.add('hidden');
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        feedback.classList.add('hidden');

        const id = document.getElementById('coupon-id').value;
        const payload = {
            code: document.getElementById('coupon-code').value.trim().toUpperCase(),
            type: document.getElementById('coupon-type').value,
            value: parseFloat(document.getElementById('coupon-value').value),
            maxDiscount: document.getElementById('coupon-max-discount').value
                ? parseFloat(document.getElementById('coupon-max-discount').value)
                : null,
            minOrderValue: parseFloat(document.getElementById('coupon-min-order').value) || 0,
            usageLimit: document.getElementById('coupon-usage-limit').value
                ? parseInt(document.getElementById('coupon-usage-limit').value, 10)
                : null,
            expiresAt: document.getElementById('coupon-expires').value || null,
            active: document.getElementById('coupon-active').checked,
        };

        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;

        try {
            if (id) {
                await Api.request(`/coupons/admin/${id}`, { method: 'PATCH', body: payload, auth: true });
            } else {
                await Api.post('/coupons/admin', payload, { auth: true });
            }
            closeModal();
            await loadCoupons();
        } catch (err) {
            feedback.textContent = err.message;
            feedback.classList.remove('hidden');
        } finally {
            submitBtn.disabled = false;
        }
    });

    document.getElementById('coupons-table-wrap').addEventListener('click', async (event) => {
        const editBtn = event.target.closest('.js-edit-coupon');
        if (editBtn) {
            const coupon = couponsCache.find((c) => c._id === editBtn.dataset.id);
            if (coupon) openModal(coupon);
            return;
        }

        const deleteBtn = event.target.closest('.js-delete-coupon');
        if (deleteBtn) {
            if (!confirm(`Delete coupon "${deleteBtn.dataset.code}"? This cannot be undone.`)) return;
            try {
                await Api.request(`/coupons/admin/${deleteBtn.dataset.id}`, { method: 'DELETE', auth: true });
                await loadCoupons();
            } catch (err) {
                alert(err.message);
            }
        }
    });
});

async function loadCoupons() {
    const wrap = document.getElementById('coupons-table-wrap');
    try {
        const data = await Api.get('/coupons/admin/all', { auth: true });
        couponsCache = data.coupons || [];
        wrap.innerHTML = renderCouponsTable(couponsCache);
    } catch (err) {
        wrap.innerHTML = `<p class="loading-note">Could not load coupons: ${err.message}</p>`;
    }
}

function renderCouponsTable(coupons) {
    if (!coupons || coupons.length === 0) {
        return `<div class="empty-state"><span class="material-symbols-outlined">sell</span><p>No coupons yet. Create one to get started.</p></div>`;
    }

    const rows = coupons
        .map((c) => {
            const valueLabel = c.type === 'percent' ? `${c.value}%` : `$${c.value.toFixed(2)}`;
            const usageLabel = c.usageLimit != null ? `${c.usedCount} / ${c.usageLimit}` : `${c.usedCount} / ∞`;
            const expiresLabel = c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : '—';
            const isExpired = c.expiresAt && new Date(c.expiresAt).getTime() < Date.now();

            return `
        <tr>
            <td><strong>${c.code}</strong></td>
            <td>${valueLabel}</td>
            <td>${c.minOrderValue > 0 ? `$${c.minOrderValue.toFixed(2)}` : '—'}</td>
            <td>${usageLabel}</td>
            <td>${expiresLabel}</td>
            <td><span class="status-badge ${c.active && !isExpired ? 'status-paid' : 'status-cancelled'}">${
                isExpired ? 'expired' : c.active ? 'active' : 'inactive'
            }</span></td>
            <td>
                <button type="button" class="js-edit-coupon" data-id="${c._id}" style="background:#2a2f3d; color:#f5f5f7; border:1px solid #3a3f4d; border-radius:6px; padding:6px 10px; cursor:pointer; font-size:12px; margin-right:6px;">Edit</button>
                <button type="button" class="js-delete-coupon" data-id="${c._id}" data-code="${c.code}" style="background:#3a1010; color:#f87171; border:1px solid #5a2020; border-radius:6px; padding:6px 10px; cursor:pointer; font-size:12px;">Delete</button>
            </td>
        </tr>`;
        })
        .join('');

    return `
        <table class="admin-table">
            <thead>
                <tr><th>Code</th><th>Discount</th><th>Min Order</th><th>Usage</th><th>Expires</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}
