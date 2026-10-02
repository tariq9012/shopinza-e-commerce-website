/* ==========================================================
   Shopinza - product.js
   Loads a single product from the backend based on the
   ?slug=... URL parameter and populates product-details.html:
   gallery, colors, price, description, tabs, and wires the
   Add to Cart / Buy Now buttons into Cart.
   Depends on config.js, cart.js, and products.js.
   ========================================================== */

let currentProduct = null;
let selectedColor = null;
let selectedSize = null;
let viewerListenerRegistered = false;

function getSlugFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('slug');
}

function renderGalleryThumbs(product) {
    const thumbsContainer = document.getElementById('pd-thumbs');
    if (!thumbsContainer) return;

    const images = [product.image, ...(product.images || [])];

    thumbsContainer.innerHTML = images
        .map(
            (src, i) =>
                `<img class="js-thumb${i === 0 ? ' active' : ''}" src="${src}" alt="${escapeHtml(product.name)} view ${i + 1}" />`
        )
        .join('');

    thumbsContainer.querySelectorAll('.js-thumb').forEach((thumb) => {
        thumb.addEventListener('click', () => {
            document.getElementById('pd-main-image').src = thumb.src;
            thumbsContainer.querySelectorAll('.js-thumb').forEach((t) => t.classList.remove('active'));
            thumb.classList.add('active');
        });
    });
}

function renderColorOptions(product) {
    const section = document.getElementById('pd-colors-section');
    const container = document.getElementById('pd-color-options');
    const label = document.getElementById('pd-color-label');
    if (!section || !container) return;

    if (!product.colors || product.colors.length === 0) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    selectedColor = product.colors[0].name;
    label.textContent = selectedColor;

    container.innerHTML = product.colors
        .map(
            (color, i) => `
                <button class="pd-color-swatch js-color-swatch${i === 0 ? ' active' : ''}"
                        data-color="${escapeHtml(color.name)}"
                        style="background:${color.hex}"
                        aria-label="${escapeHtml(color.name)}"></button>
            `
        )
        .join('');

    container.querySelectorAll('.js-color-swatch').forEach((swatch) => {
        swatch.addEventListener('click', () => {
            container.querySelectorAll('.js-color-swatch').forEach((s) => s.classList.remove('active'));
            swatch.classList.add('active');
            selectedColor = swatch.dataset.color;
            label.textContent = selectedColor;
            renderSizeOptions(currentProduct); // stock-per-size depends on which color is picked
            updateAddToCartAvailability();
        });
    });
}

/** Only shown for products with variants (size/color-specific stock). */
function renderSizeOptions(product) {
    const section = document.getElementById('pd-sizes-section');
    const container = document.getElementById('pd-size-options');
    const label = document.getElementById('pd-size-label');
    if (!section || !container) return;

    if (!product.variants || product.variants.length === 0) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');

    const sizesToShow = product.sizes && product.sizes.length > 0 ? product.sizes : [...new Set(product.variants.map((v) => v.size))];

    // keep the current size selection if it's still valid for the newly
    // picked color, otherwise clear it and make the person pick again
    const stillAvailable = sizesToShow.includes(selectedSize);
    if (!stillAvailable) {
        selectedSize = null;
        label.textContent = 'Select a size';
    }

    container.innerHTML = sizesToShow
        .map((size) => {
            const variant = product.variants.find((v) => v.color === selectedColor && v.size === size);
            const outOfStock = !variant || variant.stock <= 0;
            const activeClass = size === selectedSize ? ' active' : '';
            const oosClass = outOfStock ? ' out-of-stock' : '';
            return `<button type="button" class="pd-size-btn js-size-btn${activeClass}${oosClass}" data-size="${escapeHtml(size)}" ${outOfStock ? 'disabled' : ''}>${escapeHtml(size)}</button>`;
        })
        .join('');

    container.querySelectorAll('.js-size-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            container.querySelectorAll('.js-size-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            selectedSize = btn.dataset.size;
            label.textContent = selectedSize;
            updateAddToCartAvailability();
        });
    });
}

/** Finds the variant matching the currently-selected color+size, if any. */
function getSelectedVariant(product) {
    if (!product.variants || product.variants.length === 0) return null;
    return product.variants.find((v) => v.color === selectedColor && v.size === selectedSize) || null;
}

/**
 * Updates the stock note + enables/disables Add to Cart based on the
 * selected color/size combination (for products with variants) or the
 * product's flat `stock` field (for products without variants).
 */
function updateAddToCartAvailability() {
    if (!currentProduct) return;

    const stockNoteEl = document.getElementById('pd-stock-note');
    const addToCartBtn = document.querySelector('.js-pd-add-cart');
    const buyNowBtn = document.querySelector('.js-pd-buy-now');
    const hasVariants = currentProduct.variants && currentProduct.variants.length > 0;

    let available;
    let note;

    if (hasVariants) {
        if (!selectedSize) {
            available = 0;
            note = 'Please select a size';
        } else {
            const variant = getSelectedVariant(currentProduct);
            available = variant ? variant.stock : 0;
            note = available > 0 ? `Only ${available} left in stock` : 'Out of stock in this size/color';
        }
    } else {
        available = currentProduct.stock;
        note = available > 0 ? `Only ${available} left in stock` : 'Currently out of stock';
    }

    if (stockNoteEl) stockNoteEl.textContent = note;

    const disabled = available <= 0;
    if (addToCartBtn) {
        addToCartBtn.disabled = disabled;
        addToCartBtn.textContent = ''; // cleared then rebuilt below so the icon survives
        addToCartBtn.innerHTML = disabled
            ? (hasVariants && !selectedSize ? 'Select a Size' : 'Out of Stock')
            : '<span class="material-symbols-outlined">shopping_bag</span> Add to Cart';
    }
    if (buyNowBtn) buyNowBtn.disabled = disabled;
}

function renderProduct(product) {
    currentProduct = product;

    document.title = `Shopinza - ${product.name}`;

    document.getElementById('pd-main-image').src = product.image;
    document.getElementById('pd-main-image').alt = product.name;
    document.getElementById('pd-title').textContent = product.name;
    document.getElementById('pd-price').textContent = `$${product.price.toFixed(2)}`;

    const oldPriceEl = document.getElementById('pd-price-old');
    if (product.oldPrice && product.oldPrice > product.price) {
        oldPriceEl.textContent = `$${product.oldPrice.toFixed(2)}`;
        oldPriceEl.classList.remove('hidden');
    } else {
        oldPriceEl.classList.add('hidden');
    }

    document.getElementById('pd-description').textContent =
        product.description || 'No description available for this product yet.';

    document.getElementById('pd-rating').innerHTML = `
        ${Products.ratingStars(product.rating)}
        <span class="rating-count">${product.rating.toFixed(1)} (${product.reviewCount} reviews)</span>
    `;

    document.getElementById('pd-specs-description').textContent =
        product.description || 'More details for this product will be added soon.';
    document.getElementById('pd-review-count').textContent = product.reviewCount;

    const actionsEl = document.getElementById('pd-actions');
    actionsEl.dataset.id = product.slug;
    actionsEl.dataset.name = product.name;
    actionsEl.dataset.price = product.price;
    actionsEl.dataset.image = product.image;

    selectedColor = null;
    selectedSize = null;

    renderGalleryThumbs(product);
    renderColorOptions(product); // sets selectedColor
    renderSizeOptions(product); // depends on selectedColor being set above
    updateAddToCartAvailability();

    // ---------- "X people viewing this product" ----------
    if (typeof AppSocket !== 'undefined') {
        AppSocket.joinProduct(product.slug);

        if (!viewerListenerRegistered) {
            viewerListenerRegistered = true;
            AppSocket.onProductViewers((data) => {
                if (!currentProduct || data.slug !== currentProduct.slug) return;

                const note = document.getElementById('pd-viewers-note');
                const countEl = document.getElementById('pd-viewers-count');
                if (!note || !countEl) return;

                // only worth showing once there's actually a crowd - "1
                // person viewing" (just you) isn't interesting to anyone
                if (data.count > 1) {
                    countEl.textContent = data.count;
                    note.classList.remove('hidden');
                } else {
                    note.classList.add('hidden');
                }
            });
        }
    }

    document.dispatchEvent(new CustomEvent('products:rendered'));
}

function showProductNotFound() {
    const main = document.querySelector('main.page-main');
    if (main) {
        main.innerHTML = `
            <div style="text-align:center; padding: 80px 24px;">
                <span class="material-symbols-outlined" style="font-size:48px; color:#787680;">search_off</span>
                <h1 style="margin-top:16px; color:#070235;">Product not found</h1>
                <p style="color:#47464f; margin-top:8px;">This product may have been removed, or the backend server isn't running.</p>
                <a href="shop.html" class="a"><button class="btn-primary" style="margin-top:24px;">Back to Shop</button></a>
            </div>
        `;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const slug = getSlugFromUrl();

    if (!slug) {
        showProductNotFound();
        return;
    }

    try {
        const data = await Api.get(`/products/${slug}`);
        renderProduct(data.product);
    } catch (err) {
        console.error('Could not load product:', err);
        showProductNotFound();
        return;
    }

    /* ---------- Quantity stepper ---------- */
    const qtyDisplay = document.getElementById('pd-qty');
    const qtyMinusBtn = document.querySelector('.js-qty-minus');
    const qtyPlusBtn = document.querySelector('.js-qty-plus');

    function getQty() {
        return qtyDisplay ? parseInt(qtyDisplay.textContent, 10) || 1 : 1;
    }

    if (qtyPlusBtn) {
        qtyPlusBtn.addEventListener('click', () => {
            if (qtyDisplay) qtyDisplay.textContent = getQty() + 1;
        });
    }
    if (qtyMinusBtn) {
        qtyMinusBtn.addEventListener('click', () => {
            if (qtyDisplay) qtyDisplay.textContent = Math.max(1, getQty() - 1);
        });
    }

    /* ---------- Tabs ---------- */
    const tabButtons = document.querySelectorAll('.js-pd-tab');
    const tabPanels = {
        specs: document.getElementById('pd-tab-specs'),
        features: document.getElementById('pd-tab-features'),
        reviews: document.getElementById('pd-tab-reviews'),
    };

    tabButtons.forEach((tabBtn) => {
        tabBtn.addEventListener('click', () => {
            tabButtons.forEach((btn) => btn.classList.remove('active'));
            tabBtn.classList.add('active');
            Object.values(tabPanels).forEach((panel) => panel && panel.classList.add('hidden'));
            const target = tabPanels[tabBtn.dataset.tab];
            if (target) target.classList.remove('hidden');
        });
    });

    /* ---------- Add to Cart / Buy Now ---------- */
    const actionsEl = document.getElementById('pd-actions');
    const addToCartBtn = document.querySelector('.js-pd-add-cart');
    const buyNowBtn = document.querySelector('.js-pd-buy-now');

    function addCurrentProductToCart() {
        if (!actionsEl || !currentProduct) return;

        const hasVariants = currentProduct.variants && currentProduct.variants.length > 0;
        if (hasVariants && (!selectedColor || !selectedSize)) return; // shouldn't happen - the button is disabled until both are picked

        const qty = getQty();
        for (let i = 0; i < qty; i++) {
            Cart.addItem({
                id: actionsEl.dataset.id,
                name: actionsEl.dataset.name,
                price: actionsEl.dataset.price,
                image: actionsEl.dataset.image,
                color: hasVariants ? selectedColor : undefined,
                size: hasVariants ? selectedSize : undefined,
            });
        }
    }

    if (addToCartBtn) {
        addToCartBtn.addEventListener('click', () => {
            addCurrentProductToCart();
            const originalHTML = addToCartBtn.innerHTML;
            addToCartBtn.innerHTML = '<span class="material-symbols-outlined">check</span> Added to Cart';
            setTimeout(() => {
                addToCartBtn.innerHTML = originalHTML;
            }, 1200);
        });
    }

    if (buyNowBtn) {
        buyNowBtn.addEventListener('click', () => {
            addCurrentProductToCart();
            window.location.href = 'cart.html';
        });
    }

    /* ---------- Size chart modal ---------- */
    const sizeChartOverlay = document.getElementById('size-chart-overlay');
    const sizeChartOpenBtn = document.querySelector('.js-size-chart-open');
    const sizeChartCloseBtn = document.getElementById('size-chart-close');

    if (sizeChartOpenBtn && sizeChartOverlay) {
        sizeChartOpenBtn.addEventListener('click', () => sizeChartOverlay.classList.remove('hidden'));
    }
    if (sizeChartCloseBtn && sizeChartOverlay) {
        sizeChartCloseBtn.addEventListener('click', () => sizeChartOverlay.classList.add('hidden'));
    }
    if (sizeChartOverlay) {
        sizeChartOverlay.addEventListener('click', (event) => {
            if (event.target === sizeChartOverlay) sizeChartOverlay.classList.add('hidden');
        });
    }
});