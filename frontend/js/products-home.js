/* ==========================================================
   Shopinza - products-home.js
   Loads a handful of featured products from the backend and
   renders them into the "Popular Products" grid on index.html.
   Depends on config.js, cart.js, and products.js.
   ========================================================== */

document.addEventListener('DOMContentLoaded', async () => {
    const grid = document.getElementById('home-products-grid');
    if (!grid) return;

    const products = await Products.fetchAll({ sort: 'latest', limit: 4 });

    if (products === null) {
        grid.innerHTML = Products.renderEmptyState(
            'Could not load products. Make sure the backend server is running.'
        );
        return;
    }

    if (products.length === 0) {
        grid.innerHTML = Products.renderEmptyState(
            'No products yet. Run "npm run seed" in the backend to add demo products.'
        );
        return;
    }

    grid.innerHTML = products.map((p) => Products.renderHomeCard(p)).join('');
    document.dispatchEvent(new CustomEvent('products:rendered'));
});