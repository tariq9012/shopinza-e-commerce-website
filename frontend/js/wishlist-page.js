/* ==========================================================
   Shopinza - wishlist-page.js
   "My Wishlist" page: renders full product cards for every id
   in Wishlist.getIds() (see cart.js). Depends on config.js,
   cart.js (for the Wishlist object + add-to-cart/heart click
   wiring), and products.js (for Products.renderShopCard).
   ========================================================== */

function renderWishlistSignInPrompt() {
    return `
        <div class="orders-empty-state">
            <span class="material-symbols-outlined">lock</span>
            <p>Please sign in to see your wishlist.</p>
            <a href="login.html" class="btn-primary" style="display:inline-block; margin-top:12px; text-decoration:none;">Sign In</a>
        </div>
    `;
}

function renderWishlistEmptyState() {
    return `
        <div class="orders-empty-state">
            <span class="material-symbols-outlined">favorite_border</span>
            <p>You haven't saved anything yet.</p>
            <a href="shop.html" class="btn-primary" style="display:inline-block; margin-top:12px; text-decoration:none;">Browse Products</a>
        </div>
    `;
}

async function loadWishlistPage() {
    const wrap = document.getElementById('wishlist-grid');
    const ids = Wishlist.getIds();

    if (ids.length === 0) {
        wrap.innerHTML = renderWishlistEmptyState();
        return;
    }

    try {
        const products = await Promise.all(
            ids.map((id) =>
                Api.get(`/products/${id}`)
                    .then((data) => data.product)
                    .catch(() => null) // product was deleted/renamed since being favorited - just skip it
            )
        );

        const validProducts = products.filter(Boolean);

        if (validProducts.length === 0) {
            wrap.innerHTML = renderWishlistEmptyState();
            return;
        }

        wrap.innerHTML = validProducts.map((product) => Products.renderShopCard(product)).join('');
        document.dispatchEvent(new CustomEvent('products:rendered')); // lets cart.js mark the heart icons as active
    } catch (err) {
        wrap.innerHTML = `<div class="orders-empty-state"><span class="material-symbols-outlined">error</span><p>Could not load your wishlist.</p></div>`;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const wrap = document.getElementById('wishlist-grid');
    if (!wrap) return;

    if (!Api.isLoggedIn()) {
        wrap.innerHTML = renderWishlistSignInPrompt();
        return;
    }

    await loadWishlistPage();

    // Every card shown here is, by definition, already favorited - so on
    // this page, clicking the heart always means "remove from wishlist".
    // cart.js's own delegated listener handles the actual toggle/backend
    // sync; this just removes the card from view.
    wrap.addEventListener('click', (event) => {
        const wishlistBtn = event.target.closest('.js-wishlist');
        if (!wishlistBtn) return;

        const card = wishlistBtn.closest('[data-id]');
        if (card) card.remove();

        if (wrap.querySelectorAll('[data-id]').length === 0) {
            wrap.innerHTML = renderWishlistEmptyState();
        }
    });
});
