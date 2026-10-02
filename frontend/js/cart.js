/* ==========================================================
   Shopinza - cart.js
   Core cart module (frontend only, uses localStorage).
   Loaded on every page. Uses event delegation so it also
   works on product cards that get rendered dynamically after
   fetching from the backend (see products.js).
   ========================================================== */

const Cart = {
    STORAGE_KEY: 'shopinza_cart',

    getItems() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (err) {
            console.error('Cart: could not read cart from storage', err);
            return [];
        }
    },

    saveItems(items) {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(items));
        document.dispatchEvent(new CustomEvent('cart:updated'));
        this.syncToBackend(items);
    },

    // Pushes the current cart to the backend so it survives a device/browser
    // change or a cache clear. Fire-and-forget: a failed sync (offline,
    // backend down) should never block using the cart locally.
    syncToBackend(items) {
        if (typeof Api === 'undefined' || !Api.isLoggedIn()) return;
        Api.request('/cart', { method: 'PUT', body: { items }, auth: true }).catch((err) => {
            console.warn('Cart: could not sync cart to server', err);
        });
    },

    // Called right after a successful login (see auth.js). Combines whatever
    // was in the guest cart on this device with whatever was already saved
    // on the account (from another device/session), then saves the merged
    // result both locally and back to the server.
    async mergeAfterLogin() {
        if (typeof Api === 'undefined' || !Api.isLoggedIn()) return;

        const localItems = this.getItems();
        let savedItems = [];
        try {
            const data = await Api.request('/cart', { auth: true });
            savedItems = data.items || [];
        } catch (err) {
            console.warn('Cart: could not load saved cart', err);
        }

        const merged = savedItems.map((item) => ({ ...item }));
        localItems.forEach((localItem) => {
            const existing = merged.find((item) => item.id === localItem.id);
            if (existing) {
                existing.qty += localItem.qty;
            } else {
                merged.push({ ...localItem });
            }
        });

        this.saveItems(merged);
    },

    /**
     * `id` here is always the product's slug. When `color`/`size` are given
     * (a variant was selected on the product page), the cart LINE gets its
     * own composite id so different variants of the same product show up as
     * separate lines - `productId` always stays the plain slug underneath,
     * for stock lookups and checkout.
     */
    addItem({ id, name, price, image, color, size }) {
        const items = this.getItems();
        const hasVariant = Boolean(color && size);
        const lineId = hasVariant ? `${id}::${color}::${size}` : id;
        const existing = items.find((item) => item.id === lineId);

        if (existing) {
            existing.qty += 1;
        } else {
            const newItem = { id: lineId, productId: id, name, price: parseFloat(price) || 0, image, qty: 1 };
            if (hasVariant) {
                newItem.color = color;
                newItem.size = size;
            }
            items.push(newItem);
        }

        this.saveItems(items);
    },

    removeItem(id) {
        const items = this.getItems().filter((item) => item.id !== id);
        this.saveItems(items);
    },

    setQty(id, qty) {
        const items = this.getItems();
        const item = items.find((i) => i.id === id);
        if (!item) return;

        if (qty <= 0) {
            this.removeItem(id);
            return;
        }

        item.qty = qty;
        this.saveItems(items);
    },

    incrementQty(id) {
        const item = this.getItems().find((i) => i.id === id);
        if (item) this.setQty(id, item.qty + 1);
    },

    decrementQty(id) {
        const item = this.getItems().find((i) => i.id === id);
        if (item) this.setQty(id, item.qty - 1);
    },

    getCount() {
        return this.getItems().reduce((sum, item) => sum + item.qty, 0);
    },

    getSubtotal() {
        return this.getItems().reduce((sum, item) => sum + item.price * item.qty, 0);
    },

    clear() {
        this.saveItems([]);
    },

    formatPrice(amount) {
        return '$' + amount.toFixed(2);
    },
};

/* ---------- Wishlist (simple favorite toggle, localStorage) ---------- */

const Wishlist = {
    STORAGE_KEY: 'shopinza_wishlist',

    getIds() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            return raw ? JSON.parse(raw) : [];
        } catch (err) {
            return [];
        }
    },

    saveIds(ids) {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(ids));
        this.syncToBackend(ids);
    },

    toggle(id) {
        let ids = this.getIds();
        if (ids.includes(id)) {
            ids = ids.filter((existingId) => existingId !== id);
        } else {
            ids.push(id);
        }
        this.saveIds(ids);
        return ids.includes(id);
    },

    isFavorited(id) {
        return this.getIds().includes(id);
    },

    // Pushes the current wishlist to the backend so it survives a device/
    // browser change or a cache clear, same as Cart.syncToBackend above.
    syncToBackend(ids) {
        if (typeof Api === 'undefined' || !Api.isLoggedIn()) return;
        Api.request('/wishlist', { method: 'PUT', body: { productIds: ids }, auth: true }).catch((err) => {
            console.warn('Wishlist: could not sync wishlist to server', err);
        });
    },

    // Called right after login (see auth.js) and once per tab session on
    // page load (see pullSavedWishlistOnce below) - combines whatever was
    // favorited on this device as a guest with whatever was already saved
    // on the account, then saves the merged result both locally and back
    // to the server. Mirrors Cart.mergeAfterLogin.
    async mergeAfterLogin() {
        if (typeof Api === 'undefined' || !Api.isLoggedIn()) return;

        const localIds = this.getIds();
        let savedIds = [];
        try {
            const data = await Api.request('/wishlist', { auth: true });
            savedIds = data.productIds || [];
        } catch (err) {
            console.warn('Wishlist: could not load saved wishlist', err);
        }

        const merged = Array.from(new Set([...savedIds, ...localIds]));
        this.saveIds(merged);
        refreshWishlistButtons();
    },
};

/* ---------- Shared UI wiring (event delegation - works for dynamic cards too) ---------- */

function updateCartBadge() {
    const badges = document.querySelectorAll('#cart-badge, .cart-badge');
    const count = Cart.getCount();
    badges.forEach((badge) => {
        badge.textContent = count;
        badge.classList.toggle('hidden', count === 0);
    });
}

function readProductDataFromCard(cardEl) {
    return {
        id: cardEl.dataset.id,
        name: cardEl.dataset.name,
        price: cardEl.dataset.price,
        image: cardEl.querySelector('img') ? cardEl.querySelector('img').src : '',
    };
}

function showAddedFeedback(button) {
    const originalHTML = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="material-symbols-outlined">check</span> Added';
    setTimeout(() => {
        button.innerHTML = originalHTML;
        button.disabled = false;
    }, 1200);
}

/** Reflects saved wishlist state onto any wishlist buttons currently in the DOM. */
function refreshWishlistButtons() {
    document.querySelectorAll('.js-wishlist').forEach((button) => {
        const card = button.closest('[data-id]');
        const id = card ? card.dataset.id : null;
        if (id) {
            button.classList.toggle('active-wishlist', Wishlist.isFavorited(id));
        }
    });
}

// Covers the "already logged in, but this browser/device has no local cart"
// case (new browser, or localStorage/cache was cleared) - pulls the saved
// cart down once per tab session so it doesn't fight with local changes.
function pullSavedCartOnce() {
    if (typeof Api === 'undefined' || !Api.isLoggedIn()) return;
    if (sessionStorage.getItem('shopinza_cart_pulled')) return;
    sessionStorage.setItem('shopinza_cart_pulled', '1');
    Cart.mergeAfterLogin();
}

// Same idea as pullSavedCartOnce, but for the wishlist.
function pullSavedWishlistOnce() {
    if (typeof Api === 'undefined' || !Api.isLoggedIn()) return;
    if (sessionStorage.getItem('shopinza_wishlist_pulled')) return;
    sessionStorage.setItem('shopinza_wishlist_pulled', '1');
    Wishlist.mergeAfterLogin();
}

document.addEventListener('DOMContentLoaded', () => {
    updateCartBadge();
    refreshWishlistButtons();
    pullSavedCartOnce();
    pullSavedWishlistOnce();

    // single delegated click handler - works for cards that exist now AND
    // cards that get rendered later (dynamic product listings)
    document.addEventListener('click', (event) => {
        const addCartBtn = event.target.closest('.js-add-cart');
        if (addCartBtn) {
            const card = addCartBtn.closest('[data-id]');
            if (card) {
                Cart.addItem(readProductDataFromCard(card));
                showAddedFeedback(addCartBtn);
            }
            return;
        }

        const wishlistBtn = event.target.closest('.js-wishlist');
        if (wishlistBtn) {
            const card = wishlistBtn.closest('[data-id]');
            const id = card ? card.dataset.id : null;
            if (id) {
                const isFav = Wishlist.toggle(id);
                wishlistBtn.classList.toggle('active-wishlist', isFav);
            }
            return;
        }

        const cartIconBtn = event.target.closest('.js-cart-icon');
        if (cartIconBtn) {
            window.location.href = 'cart.html';
        }
    });

    document.addEventListener('cart:updated', updateCartBadge);
    document.addEventListener('products:rendered', refreshWishlistButtons);
});