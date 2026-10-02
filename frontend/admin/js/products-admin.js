/* ==========================================================
   Shopinza Admin - products-admin.js
   Lists products from the backend and wires the add/edit
   modal (POST /api/products, PUT /api/products/id/:id) and
   delete (DELETE /api/products/id/:id).
   ========================================================== */

let productsCache = [];
let currentGalleryImages = []; // [{url, publicId}] for the product being added/edited
let currentColors = []; // [{name, hex}] for the product being added/edited
let isMainImageUploading = false;
let isGalleryUploading = false;

document.addEventListener('DOMContentLoaded', async () => {
    const admin = await AdminGuard.verify();
    if (!admin) return;

    AdminGuard.renderSidebar('products');

    await loadProducts();

    const overlay = document.getElementById('product-modal-overlay');
    const form = document.getElementById('product-form');
    const modalTitle = document.getElementById('product-modal-title');
    const feedback = document.getElementById('product-form-feedback');

    const mainImageFileInput = document.getElementById('product-image-file');
    const mainImageHidden = document.getElementById('product-image');
    const mainImagePreview = document.getElementById('product-image-preview');
    const mainImageStatus = document.getElementById('product-image-status');

    const galleryFileInput = document.getElementById('product-gallery-file');
    const galleryStatus = document.getElementById('product-gallery-status');
    const galleryPreviewWrap = document.getElementById('product-gallery-preview-wrap');

    const colorsListEl = document.getElementById('product-colors-list');
    const addColorBtn = document.getElementById('add-color-row-btn');
    const sizesInput = document.getElementById('product-sizes');
    const variantsSection = document.getElementById('product-variants-section');
    const variantsTable = document.getElementById('product-variants-table');

    document.getElementById('add-product-btn').addEventListener('click', () => {
        openModal();
    });

    document.getElementById('product-modal-cancel').addEventListener('click', () => {
        closeModal();
    });

    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) closeModal();
    });

    // ---------- main image upload ----------
    mainImageFileInput.addEventListener('change', async () => {
        const file = mainImageFileInput.files[0];
        if (!file) return;

        isMainImageUploading = true;
        setStatus(mainImageStatus, 'Uploading…', 'uploading');

        try {
            const [data] = await Api.uploadImagesDirect([file], 'product');
            mainImageHidden.value = data.url;
            mainImagePreview.src = data.url;
            mainImagePreview.classList.remove('hidden');
            setStatus(mainImageStatus, 'Uploaded ✓', 'success');
        } catch (err) {
            setStatus(mainImageStatus, err.message, 'error');
            mainImageFileInput.value = '';
        } finally {
            isMainImageUploading = false;
        }
    });

    // ---------- gallery images upload ----------
    galleryFileInput.addEventListener('change', async () => {
        const files = Array.from(galleryFileInput.files);
        if (files.length === 0) return;

        isGalleryUploading = true;
        setStatus(galleryStatus, `Uploading ${files.length} image(s)…`, 'uploading');

        try {
            const uploaded = await Api.uploadImagesDirect(files, 'product');
            currentGalleryImages = currentGalleryImages.concat(uploaded);
            renderGalleryPreview();
            setStatus(galleryStatus, 'Uploaded ✓', 'success');
        } catch (err) {
            setStatus(galleryStatus, err.message, 'error');
        } finally {
            isGalleryUploading = false;
            galleryFileInput.value = '';
        }
    });

    function setStatus(el, text, kind) {
        el.textContent = text;
        el.className = `upload-status ${kind || ''}`.trim();
    }

    function renderGalleryPreview() {
        // clear existing thumbs but keep the status span
        galleryPreviewWrap.querySelectorAll('img.thumb').forEach((img) => img.remove());

        currentGalleryImages.forEach((img, index) => {
            const thumb = document.createElement('img');
            thumb.className = 'thumb';
            thumb.src = img.url;
            thumb.title = 'Click to remove';
            thumb.style.cursor = 'pointer';
            thumb.addEventListener('click', () => {
                currentGalleryImages.splice(index, 1);
                renderGalleryPreview();
            });
            galleryPreviewWrap.insertBefore(thumb, galleryStatus);
        });
    }

    // ---------- Colors ----------
    function renderColorsList() {
        colorsListEl.innerHTML = currentColors
            .map(
                (color, i) => `
                <div class="admin-field-row" data-color-row="${i}" style="align-items:flex-end; margin-bottom:8px;">
                    <div class="admin-field" style="margin-bottom:0;">
                        <input type="text" class="js-color-name" placeholder="Color name (e.g. Red)" value="${escapeHtml(color.name)}" />
                    </div>
                    <div class="admin-field" style="margin-bottom:0; max-width:100px;">
                        <input type="color" class="js-color-hex" value="${color.hex || '#000000'}" />
                    </div>
                    <button type="button" class="btn-icon-sm danger js-remove-color" title="Remove"><span class="material-symbols-outlined">delete</span></button>
                </div>
            `
            )
            .join('');

        colorsListEl.querySelectorAll('[data-color-row]').forEach((row) => {
            const i = parseInt(row.dataset.colorRow, 10);
            row.querySelector('.js-color-name').addEventListener('input', (e) => {
                currentColors[i].name = e.target.value;
                rebuildVariantsGrid();
            });
            row.querySelector('.js-color-hex').addEventListener('input', (e) => {
                currentColors[i].hex = e.target.value;
            });
            row.querySelector('.js-remove-color').addEventListener('click', () => {
                currentColors.splice(i, 1);
                renderColorsList();
                rebuildVariantsGrid();
            });
        });
    }

    addColorBtn.addEventListener('click', () => {
        currentColors.push({ name: '', hex: '#070235' });
        renderColorsList();
    });

    // ---------- Sizes + stock-per-variant grid ----------
    function getSizesFromInput() {
        return sizesInput.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    }

    sizesInput.addEventListener('input', () => rebuildVariantsGrid());

    /**
     * Rebuilds the color x size stock table from the current colors list +
     * sizes input, preserving any stock numbers already typed in for
     * combinations that still exist (keyed by "color::size").
     */
    function rebuildVariantsGrid(existingVariants) {
        const sizes = getSizesFromInput();
        const colorNames = currentColors.map((c) => c.name.trim()).filter(Boolean);

        if (sizes.length === 0 || colorNames.length === 0) {
            variantsSection.classList.add('hidden');
            variantsTable.innerHTML = '';
            return;
        }

        // preserve values already on the grid (or from the product being edited, the first time)
        const previousValues = {};
        variantsTable.querySelectorAll('.js-variant-stock').forEach((input) => {
            previousValues[input.dataset.key] = input.value;
        });
        (existingVariants || []).forEach((v) => {
            const key = `${v.color}::${v.size}`;
            if (!(key in previousValues)) previousValues[key] = v.stock;
        });

        const headerRow = `<tr><th>Color \\ Size</th>${sizes.map((s) => `<th>${escapeHtml(s)}</th>`).join('')}</tr>`;
        const bodyRows = colorNames
            .map((color) => {
                const cells = sizes
                    .map((size) => {
                        const key = `${color}::${size}`;
                        const value = previousValues[key] !== undefined ? previousValues[key] : 0;
                        return `<td><input type="number" min="0" class="js-variant-stock" data-key="${escapeHtml(key)}" data-color="${escapeHtml(color)}" data-size="${escapeHtml(size)}" value="${value}" style="width:70px;" /></td>`;
                    })
                    .join('');
                return `<tr><td>${escapeHtml(color)}</td>${cells}</tr>`;
            })
            .join('');

        variantsTable.innerHTML = `<thead>${headerRow}</thead><tbody>${bodyRows}</tbody>`;
        variantsSection.classList.remove('hidden');
    }

    function getVariantsFromGrid() {
        return Array.from(variantsTable.querySelectorAll('.js-variant-stock')).map((input) => ({
            color: input.dataset.color,
            size: input.dataset.size,
            stock: parseInt(input.value, 10) || 0,
        }));
    }

    function openModal(product) {
        form.reset();
        feedback.classList.add('hidden');
        document.getElementById('product-id').value = product ? product._id : '';
        modalTitle.textContent = product ? 'Edit Product' : 'Add Product';

        mainImageHidden.value = '';
        mainImagePreview.classList.add('hidden');
        mainImagePreview.src = '';
        setStatus(mainImageStatus, '', '');

        currentGalleryImages = [];
        setStatus(galleryStatus, '', '');
        renderGalleryPreview();

        currentColors = [];
        sizesInput.value = '';
        renderColorsList();
        variantsSection.classList.add('hidden');
        variantsTable.innerHTML = '';

        if (product) {
            document.getElementById('product-name').value = product.name;
            document.getElementById('product-category').value = product.category;
            document.getElementById('product-stock').value = product.stock;
            document.getElementById('product-price').value = product.price;
            document.getElementById('product-old-price').value = product.oldPrice || '';
            document.getElementById('product-description').value = product.description || '';

            mainImageHidden.value = product.image;
            if (product.image) {
                mainImagePreview.src = product.image;
                mainImagePreview.classList.remove('hidden');
            }

            currentGalleryImages = (product.images || []).map((url) => ({ url }));
            renderGalleryPreview();

            currentColors = (product.colors || []).map((c) => ({ name: c.name, hex: c.hex }));
            renderColorsList();
            sizesInput.value = (product.sizes || []).join(', ');
            rebuildVariantsGrid(product.variants || []);
        }

        overlay.classList.remove('hidden');
    }

    function closeModal() {
        overlay.classList.add('hidden');
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        if (isMainImageUploading || isGalleryUploading) {
            feedback.textContent = 'Please wait for the image upload to finish.';
            feedback.classList.remove('hidden');
            return;
        }

        if (!mainImageHidden.value) {
            feedback.textContent = 'Please upload a main image for the product.';
            feedback.classList.remove('hidden');
            return;
        }

        const validColors = currentColors.filter((c) => c.name.trim());
        if (currentColors.length > 0 && validColors.length !== currentColors.length) {
            feedback.textContent = 'Please name every color, or remove the empty ones.';
            feedback.classList.remove('hidden');
            return;
        }

        const sizes = getSizesFromInput();
        const variants = sizes.length > 0 && validColors.length > 0 ? getVariantsFromGrid() : [];

        const id = document.getElementById('product-id').value;
        const payload = {
            name: document.getElementById('product-name').value.trim(),
            category: document.getElementById('product-category').value,
            stock: parseInt(document.getElementById('product-stock').value, 10),
            price: parseFloat(document.getElementById('product-price').value),
            oldPrice: document.getElementById('product-old-price').value
                ? parseFloat(document.getElementById('product-old-price').value)
                : undefined,
            image: mainImageHidden.value,
            images: currentGalleryImages.map((img) => img.url),
            description: document.getElementById('product-description').value.trim(),
            colors: validColors,
            sizes,
            variants,
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
            <td>${p.stock}${p.variants && p.variants.length > 0 ? ` <span style="color:#9a9aa5; font-size:11px;">(${p.variants.length} variants)</span>` : ''}</td>
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
