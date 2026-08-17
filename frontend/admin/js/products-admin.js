/* ==========================================================
   Shopinza Admin - products-admin.js
   Lists products from the backend and wires the add/edit
   modal (POST /api/products, PUT /api/products/id/:id) and
   delete (DELETE /api/products/id/:id).
   ========================================================== */

let productsCache = [];

document.addEventListener('DOMContentLoaded', async () => {
    const admin = await AdminGuard.verify();
    if (!admin) return;

    AdminGuard.renderSidebar('products');

    await loadProducts();

    const overlay = document.getElementById('product-modal-overlay');
    const form = document.getElementById('product-form');
    const modalTitle = document.getElementById('product-modal-title');
    const feedback = document.getElementById('product-form-feedback');

    document.getElementById('add-product-btn').addEventListener('click', () => {
        openModal();
    });

    document.getElementById('product-modal-cancel').addEventListener('click', () => {
        closeModal();
    });

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeModal();
    });

    function openModal(product) {
        form.reset();
        feedback.classList.add('hidden');
        document.getElementById('product-id').value = product ? product._id : '';
        modalTitle.textContent = product ? 'Edit Product' : 'Add Product';

        if (product) {
            document.getElementById('product-name').value = product.name;
            document.getElementById('product-category').value = product.category;
            document.getElementById('product-stock').value = product.stock;
            document.getElementById('product-price').value = product.price;
            document.getElementById('product-old-price').value = product.oldPrice || '';
            document.getElementById('product-image').value = product.image;
            document.getElementById('product-description').value = product.description || '';
        }

        overlay.classList.remove('hidden');
    }

    function closeModal() {
        overlay.classList.add('hidden');
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const id = document.getElementById('product-id').value;
        const payload = {
            name: document.getElementById('product-name').value.trim(),
            category: document.getElementById('product-category').value,
            stock: parseInt(document.getElementById('product-stock').value, 10),
            price: parseFloat(document.getElementById('product-price').value),
            oldPrice: document.getElementById('product-old-price').value
                ? parseFloat(document.getElementById('product-old-price').value)
                : undefined,
            image: document.getElementById('product-image').value.trim(),
            description: document.getElementById('product-description').value.trim(),
        };

        const submitBtn = document.getElementById('product-form-submit');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving…';

        try {
            if (id) {
                await Api.request(`/products/id/${id}`, { method: 'PUT', body: payload, auth: true });
            } else {
                await Api.post('/products', payload, { auth: true });
            }
            closeModal();
            await loadProducts();
        } catch (err) {
            feedback.textContent = err.message;
            feedback.classList.remove('hidden');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save Product';
        }
    });

    // event delegation for edit/delete buttons in the table
    document.getElementById('products-table-wrap').addEventListener('click', async (event) => {
        const editBtn = event.target.closest('.js-edit-product');
        if (editBtn) {
            const product = productsCache.find((p) => p._id === editBtn.dataset.id);
            if (product) openModal(product);
            return;
        }

        const deleteBtn = event.target.closest('.js-delete-product');
        if (deleteBtn) {
            const product = productsCache.find((p) => p._id === deleteBtn.dataset.id);
            if (!product) return;

            if (confirm(`Delete "${product.name}"? This cannot be undone.`)) {
                try {
                    await Api.request(`/products/id/${product._id}`, { method: 'DELETE', auth: true });
                    await loadProducts();
                } catch (err) {
                    alert(err.message);
                }
            }
        }
    });
});

async function loadProducts() {
    const wrap = document.getElementById('products-table-wrap');
    try {
        const data = await Api.get('/products');
        productsCache = data.products;
        wrap.innerHTML = renderProductsTable(productsCache);
    } catch (err) {
        wrap.innerHTML = `<p class="loading-note">Could not load products: ${err.message}</p>`;
    }
}

function renderProductsTable(products) {
    if (!products || products.length === 0) {
        return `<div class="empty-state"><span class="material-symbols-outlined">inventory_2</span><p>No products yet. Click "Add Product" to create one.</p></div>`;
    }

    const rows = products
        .map(
            (p) => `
        <tr>
            <td><img class="thumb" src="${p.image}" alt="${escapeHtml(p.name)}" /></td>
            <td>${escapeHtml(p.name)}</td>
            <td>${p.category}</td>
            <td>$${p.price.toFixed(2)}${p.oldPrice ? ` <span style="color:#9a9aa5; text-decoration:line-through; font-size:12px;">$${p.oldPrice.toFixed(2)}</span>` : ''}</td>
            <td>${p.stock}</td>
            <td>
                <button class="btn-icon-sm js-edit-product" data-id="${p._id}" title="Edit"><span class="material-symbols-outlined">edit</span></button>
                <button class="btn-icon-sm danger js-delete-product" data-id="${p._id}" title="Delete"><span class="material-symbols-outlined">delete</span></button>
            </td>
        </tr>
    `
        )
        .join('');

    return `
        <table class="admin-table">
            <thead>
                <tr><th>Image</th><th>Name</th><th>Category</th><th>Price</th><th>Stock</th><th>Actions</th></tr>
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
