/* ==========================================================
   Shopinza - shop.js
   Loads all products from the backend, then applies category
   filter, price filter, sorting, and grid/list view entirely
   client-side against the fetched data.
   Depends on config.js, cart.js, and products.js.
   ========================================================== */

let allProducts = [];
let saleOnly = false;

function getActiveCategories() {
    return Array.from(document.querySelectorAll('.js-filter-cat'))
        .filter((label) => label.querySelector('input[type="checkbox"]').checked)
        .map((label) => label.dataset.category);
}

function renderShopGrid() {
    const grid = document.getElementById('shop-grid');
    const resultsCountEl = document.getElementById('results-count');
    if (!grid) return;

    const activeCategories = getActiveCategories();
    const priceRange = document.getElementById('price-range');
    const maxPrice = priceRange ? parseFloat(priceRange.value) : Infinity;
    const sortSelect = document.querySelector('.js-sort');

    let filtered = allProducts.filter((p) => {
        const matchesCategory = activeCategories.length === 0 || activeCategories.includes(p.category);
        const matchesPrice = p.price <= maxPrice;
        const matchesSale = !saleOnly || (p.oldPrice && p.oldPrice > p.price);
        return matchesCategory && matchesPrice && matchesSale;
    });

    if (sortSelect) {
        if (sortSelect.value === 'Price: Low to High') {
            filtered = filtered.slice().sort((a, b) => a.price - b.price);
        } else if (sortSelect.value === 'Price: High to Low') {
            filtered = filtered.slice().sort((a, b) => b.price - a.price);
        } else if (sortSelect.value === 'Latest') {
            filtered = filtered.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        } else if (sortSelect.value === 'Popular') {
            filtered = filtered.slice().sort((a, b) => b.rating - a.rating);
        }
    }

    if (resultsCountEl) {
        resultsCountEl.textContent = `Showing ${filtered.length} of ${allProducts.length} results`;
    }

    if (allProducts.length === 0) {
        grid.innerHTML = Products.renderEmptyState(
            'No products yet. Run "npm run seed" in the backend to add demo products.'
        );
        return;
    }

    if (filtered.length === 0) {
        grid.innerHTML = Products.renderEmptyState('No products match these filters.');
        return;
    }

    grid.innerHTML = filtered.map((p) => Products.renderShopCard(p)).join('');
    document.dispatchEvent(new CustomEvent('products:rendered'));
}

document.addEventListener('DOMContentLoaded', async () => {
    const grid = document.getElementById('shop-grid');
    if (!grid) return;

    // Read query params coming from links like shop.html?sort=latest or shop.html?sale=true
    const urlParams = new URLSearchParams(window.location.search);
    const sortParam = urlParams.get('sort');
    const saleParam = urlParams.get('sale');

    if (saleParam === 'true') {
        saleOnly = true;
        const pageTitle = document.querySelector('.page-title');
        if (pageTitle) pageTitle.textContent = 'Sale';
        const breadcrumbCurrent = document.querySelector('.breadcrumb .current');
        if (breadcrumbCurrent) breadcrumbCurrent.textContent = 'Sale';
    }

    const products = await Products.fetchAll();

    if (products === null) {
        grid.innerHTML = Products.renderEmptyState(
            'Could not load products. Make sure the backend server is running.'
        );
        return;
    }

    allProducts = products;

    // Pre-select "Latest" in the sort dropdown if it was requested via the URL
    if (sortParam === 'latest') {
        const sortSelect = document.querySelector('.js-sort');
        if (sortSelect) {
            const latestOption = Array.from(sortSelect.options).find((opt) => opt.value === 'Latest');
            if (latestOption) sortSelect.value = 'Latest';
        }
    }

    renderShopGrid();

    /* ---------- Category filter ---------- */
    document.querySelectorAll('.js-filter-cat').forEach((label) => {
        const checkbox = label.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', () => {
            label.classList.toggle('checked', checkbox.checked);
            renderShopGrid();
        });
    });

    /* ---------- Price range filter ---------- */
    const priceRange = document.getElementById('price-range');
    const priceRangeValue = document.getElementById('price-range-value');
    if (priceRange) {
        priceRange.addEventListener('input', () => {
            const value = parseInt(priceRange.value, 10);
            if (priceRangeValue) {
                priceRangeValue.textContent = value >= 1000 ? '$1000+' : `$${value}`;
            }
            renderShopGrid();
        });
    }

    /* ---------- Sort ---------- */
    const sortSelect = document.querySelector('.js-sort');
    if (sortSelect) {
        sortSelect.addEventListener('change', renderShopGrid);
    }

    /* ---------- Grid / List view toggle ---------- */
    const gridViewBtn = document.querySelector('.js-view-grid');
    const listViewBtn = document.querySelector('.js-view-list');
    if (gridViewBtn && listViewBtn) {
        gridViewBtn.addEventListener('click', () => {
            gridViewBtn.classList.add('active');
            listViewBtn.classList.remove('active');
            grid.classList.remove('shop-grid-list');
        });
        listViewBtn.addEventListener('click', () => {
            listViewBtn.classList.add('active');
            gridViewBtn.classList.remove('active');
            grid.classList.add('shop-grid-list');
        });
    }

    /* ---------- Pagination (cosmetic - real paging needs backend page params) ---------- */
    document.querySelectorAll('.js-page').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.js-page').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
});