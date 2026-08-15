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
    },

    addItem({ id, name, price, image }) {
        const items = this.getItems();
        const existing = items.find((item) => item.id === id);

        if (existing) {
            existing.qty += 1;
        } else {
            items.push({ id, name, price: parseFloat(price) || 0, image, qty: 1 });
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

    toggle(id) {
        let ids = this.getIds();
        if (ids.includes(id)) {
            ids = ids.filter((existingId) => existingId !== id);
        } else {
            ids.push(id);
        }
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(ids));
        return ids.includes(id);
    },

    isFavorited(id) {
        return this.getIds().includes(id);
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

document.addEventListener('DOMContentLoaded', () => {
    updateCartBadge();
    refreshWishlistButtons();

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