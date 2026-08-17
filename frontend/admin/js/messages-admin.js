/* ==========================================================
   Shopinza Admin - messages-admin.js
   Lists contact form messages (GET /api/contact) and lets the
   admin mark them resolved (PATCH /api/contact/:id/resolve).
   ========================================================== */

document.addEventListener('DOMContentLoaded', async () => {
    const admin = await AdminGuard.verify();
    if (!admin) return;

    AdminGuard.renderSidebar('messages');

    await loadMessages();

    document.getElementById('messages-table-wrap').addEventListener('click', async (event) => {
        const btn = event.target.closest('.js-toggle-resolved');
        if (!btn) return;

        try {
            await Api.request(`/contact/${btn.dataset.id}/resolve`, { method: 'PATCH', auth: true });
            await loadMessages();
        } catch (err) {
            alert(err.message);
        }
    });
});

async function loadMessages() {
    const wrap = document.getElementById('messages-table-wrap');
    try {
        const data = await Api.get('/contact', { auth: true });
        wrap.innerHTML = renderMessagesTable(data.messages);
    } catch (err) {
        wrap.innerHTML = `<p class="loading-note">Could not load messages: ${err.message}</p>`;
    }
}

function renderMessagesTable(messages) {
    if (!messages || messages.length === 0) {
        return `<div class="empty-state"><span class="material-symbols-outlined">mail</span><p>No messages yet.</p></div>`;
    }

    const rows = messages
        .map(
            (m) => `
        <tr style="${m.resolved ? 'opacity:0.5;' : ''}">
            <td>${escapeHtml(m.name)}<br><span style="color:#9a9aa5; font-size:12px;">${escapeHtml(m.email)}</span></td>
            <td>${escapeHtml(m.subject || 'General')}</td>
            <td style="max-width:320px;">${escapeHtml(m.message)}</td>
            <td>${new Date(m.createdAt).toLocaleDateString()}</td>
            <td>
                <button class="btn-admin-outline js-toggle-resolved" data-id="${m._id}">
                    ${m.resolved ? 'Mark Unread' : 'Mark Resolved'}
                </button>
            </td>
        </tr>
    `
        )
        .join('');

    return `
        <table class="admin-table">
            <thead>
                <tr><th>From</th><th>Subject</th><th>Message</th><th>Date</th><th>Action</th></tr>
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
