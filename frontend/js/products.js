/* ==========================================================
   Shopinza - products.js
   Shared helpers for fetching products from the backend and
   rendering them as HTML cards. Used by index.html (featured
   products) and shop.html (full listing).
   Depends on config.js (Api) being loaded first.
   ========================================================== */

const Products = {
    /** Fetches products from the backend. Falls back to [] on error. */
    async fetchAll({ category, sort, limit } = {}) {
        const params = new URLSearchParams();
        if (category) params.set('category', category);
        if (sort) params.set('sort', sort);
        if (limit) params.set('limit', limit);

        const query = params.toString() ? `?${params.toString()}` : '';

        try {
            const data = await Api.get(`/products${query}`);
            return data.products || [];
        } catch (err) {
            console.error('Products: could not load from backend', err);
            return null; // null = network/server error, distinct from [] = no results
        }
    },

    ratingStars(rating) {
        const fullStars = Math.floor(rating);
        const hasHalf = rating - fullStars >= 0.5;
        let stars = '★'.repeat(fullStars);
        if (hasHalf) stars += '<span class="half">★</span>';
        return stars;
    },

    /** Renders a "product-card" (home page style, with Quick Add button). */
    renderHomeCard(product) {
        return `
            <div class="product-card" data-id="${product.slug}" data-name="${escapeHtml(product.name)}" data-price="${product.price}">
                <div class="product-image">
                    <a href="product-details.html?slug=${product.slug}">
                        <img src="${product.image}" alt="${escapeHtml(product.name)}" />
                    </a>
                    <button class="wishlist-btn js-wishlist"><span class="material-symbols-outlined">favorite</span></button>
                </div>
                <div class="product-info">
                    <div class="rating">${this.ratingStars(product.rating)} <span class="rating-count">(${product.rating.toFixed(1)})</span></div>
                    <h3><a href="product-details.html?slug=${product.slug}" style="color:inherit; text-decoration:none;">${escapeHtml(product.name)}</a></h3>
                    <p class="price">$${product.price.toFixed(2)}</p>
                    <button class="btn-outline js-add-cart"><span class="material-symbols-outlined">add_shopping_cart</span> Quick Add</button>
                </div>
            </div>
        `;
    },

    /** Renders a "shop-card" (shop page style, with round add-to-cart button). */
    renderShopCard(product) {
        const hasDiscount = product.oldPrice && product.oldPrice > product.price;
        const discountPct = hasDiscount ? Math.round((1 - product.price / product.oldPrice) * 100) : 0;

        return `
            <div class="shop-card" data-id="${product.slug}" data-name="${escapeHtml(product.name)}" data-price="${product.price}" data-category="${product.category}">
                ${hasDiscount ? `<span class="badge sale">-${discountPct}%</span>` : ''}
                <div class="shop-card-image">
                    <a href="product-details.html?slug=${product.slug}">
                        <img src="${product.image}" alt="${escapeHtml(product.name)}" />
                    </a>
                    <button class="wishlist-btn js-wishlist" style="top:16px;right:16px"><span class="material-symbols-outlined">favorite</span></button>
                </div>
                <div class="shop-card-info">
                    <span class="shop-card-category">${product.category}</span>
                    <h4><a href="product-details.html?slug=${product.slug}" style="color:inherit; text-decoration:none;">${escapeHtml(product.name)}</a></h4>
                    <div class="shop-card-rating">${this.ratingStars(product.rating)}<span class="rating-count">(${product.rating.toFixed(1)})</span></div>
                    <div class="shop-card-footer">
                        <div class="price-group">
                            ${hasDiscount ? `<span class="price-old">$${product.oldPrice.toFixed(2)}</span>` : ''}
                            <span class="price-new">$${product.price.toFixed(2)}</span>
                        </div>
                        <button class="add-cart-round js-add-cart"><span class="material-symbols-outlined">add_shopping_cart</span></button>
                    </div>
                </div>
            </div>
        `;
    },

    renderEmptyState(message) {
        return `
            <div style="grid-column: 1 / -1; text-align:center; padding: 48px 24px; color:#47464f;">
                <span class="material-symbols-outlined" style="font-size:36px;">inventory_2</span>
                <p style="margin-top:12px; font-weight:600;">${message}</p>
            </div>
        `;
    },
};

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}