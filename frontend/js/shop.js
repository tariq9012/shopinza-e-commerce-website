/* ==========================================================
   Shopinza - shop.js
   Loads products page-by-page from the backend, with the
   category/price/sale/search/sort filters all applied
   server-side (so this scales past 1000+ products instead of
   fetching everything and filtering in the browser).
   Depends on config.js, cart.js, and products.js.
   ========================================================== */

const PAGE_SIZE = 12;

let currentPage = 1;
let saleOnly = false;
let searchDebounceTimer = null;

function getActiveCategories() {
    return Array.from(document.querySelectorAll('.js-filter-cat'))
        .filter((label) => label.querySelector('input[type="checkbox"]').checked)
        .map((label) => label.dataset.category);
}

function getActiveColors() {
    return Array.from(document.querySelectorAll('.color-swatch.active')).map((btn) => btn.getAttribute('aria-label'));
}

function sortParamFor(sortLabel) {
    if (sortLabel === 'Price: Low to High') return 'price_asc';
    if (sortLabel === 'Price: High to Low') return 'price_desc';
    if (sortLabel === 'Latest') return 'latest';
    if (sortLabel === 'Popular') return 'popular';
    return undefined;
}

/** Renders the "Prev 1 2 3 ... Next" controls for the given page/total. */
function renderPagination(page, totalPages) {
    const wrap = document.getElementById('pagination');
    if (!wrap) return;

    if (totalPages <= 1) {
        wrap.innerHTML = '';
        return;
    }

    // Always show first, last, current, and one neighbour on each side;
    // collapse the rest into "...".
    const pagesToShow = new Set([1, totalPages, page, page - 1, page + 1]);
    const pages = Array.from(pagesToShow)
        .filter((p) => p >= 1 && p <= totalPages)
        .sort((a, b) => a - b);

    let buttonsHtml = '';
    let lastPage = 0;
    pages.forEach((p) => {
        if (lastPage && p - lastPage > 1) {
            buttonsHtml += `<span class="dots">...</span>`;
        }
        buttonsHtml += `<button class="js-page ${p === page ? 'active' : ''}" data-page="${p}">${p}</button>`;
        lastPage = p;
    });

    wrap.innerHTML = `
        <button class="js-page-prev" ${page <= 1 ? 'disabled' : ''}><span class="material-symbols-outlined">chevron_left</span></button>
        ${buttonsHtml}
        <button class="js-page-next" ${page >= totalPages ? 'disabled' : ''}><span class="material-symbols-outlined">chevron_right</span></button>
    `;

    wrap.querySelectorAll('.js-page').forEach((btn) => {
        btn.addEventListener('click', () => {
            currentPage = parseInt(btn.dataset.page, 10);
            loadAndRenderPage();
            window.scrollTo({ top: document.querySelector('.shop-content').offsetTop - 90, behavior: 'smooth' });
        });
    });

    const prevBtn = wrap.querySelector('.js-page-prev');
    const nextBtn = wrap.querySelector('.js-page-next');
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage -= 1;
                loadAndRenderPage();
            }
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            if (currentPage < totalPages) {
                currentPage += 1;
                loadAndRenderPage();
            }
        });
    }
}

/** Fetches the current page from the backend (using all active filters) and renders it. */
async function loadAndRenderPage() {
    const grid = document.getElementById('shop-grid');
    const resultsCountEl = document.getElementById('results-count');
    if (!grid) return;

    grid.innerHTML = `<div style="grid-column: 1 / -1; text-align:center; padding: 32px; color:#47464f;">Loading products…</div>`;

    const activeCategories = getActiveCategories();
    const priceRange = document.getElementById('price-range');
    const priceValue = priceRange ? parseInt(priceRange.value, 10) : 1000;
    const sortSelect = document.querySelector('.js-sort');
    const searchInput = document.getElementById('shop-search');

    const activeColors = getActiveColors();

    const data = await Products.fetchPage({
        category: activeCategories.join(','),
        sort: sortParamFor(sortSelect ? sortSelect.value : undefined),
        search: searchInput ? searchInput.value.trim() : '',
        maxPrice: priceValue < 1000 ? priceValue : undefined, // "1000+" on the slider = no cap
        sale: saleOnly,
        color: activeColors.join(','),
        page: currentPage,
        pageSize: PAGE_SIZE,
    });

    if (data === null) {
        grid.innerHTML = Products.renderEmptyState(
            'Could not load products. Make sure the backend server is running.'
        );
        if (resultsCountEl) resultsCountEl.textContent = '';
        renderPagination(1, 1);
        return;
    }

    const { products, total, totalPages } = data;

    if (resultsCountEl) {
        const from = total === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
        const to = Math.min(currentPage * PAGE_SIZE, total);
        resultsCountEl.textContent = `Showing ${from}-${to} of ${total} results`;
    }

    if (products.length === 0) {
        grid.innerHTML = Products.renderEmptyState(
            total === 0 && !searchInputHasValue()
                ? 'No products yet. Run "npm run seed" in the backend to add demo products.'
                : 'No products match these filters.'
        );
        renderPagination(1, 1);
        return;
    }

    grid.innerHTML = products.map((p) => Products.renderShopCard(p)).join('');
    document.dispatchEvent(new CustomEvent('products:rendered'));
    renderPagination(currentPage, totalPages);
}

function searchInputHasValue() {
    const searchInput = document.getElementById('shop-search');
    return !!(searchInput && searchInput.value.trim());
}

document.addEventListener('DOMContentLoaded', () => {
    const grid = document.getElementById('shop-grid');
    if (!grid) return;

    // Read query params coming from links like shop.html?sort=latest or shop.html?sale=true
    const urlParams = new URLSearchParams(window.location.search);
    const sortParam = urlParams.get('sort');
    const saleParam = urlParams.get('sale');
    const searchParam = urlParams.get('q');
    const categoryParam = urlParams.get('category');

    if (saleParam === 'true') {
        saleOnly = true;
        const pageTitle = document.querySelector('.page-title');
        if (pageTitle) pageTitle.textContent = 'Sale';
        const breadcrumbCurrent = document.querySelector('.breadcrumb .current');
        if (breadcrumbCurrent) breadcrumbCurrent.textContent = 'Sale';
    }

    // Pre-select the sort dropdown if it was requested via the URL (e.g. footer's "New Arrivals" / "Bestsellers" links)
    const sortLabelForParam = { latest: 'Latest', popular: 'Popular' };
    if (sortLabelForParam[sortParam]) {
        const sortSelect = document.querySelector('.js-sort');
        if (sortSelect) sortSelect.value = sortLabelForParam[sortParam];
    }

    // Pre-check a category if it was requested via the URL (e.g. footer's "Accessories" link)
    if (categoryParam) {
        const matchingLabel = document.querySelector(`.js-filter-cat[data-category="${categoryParam}"]`);
        if (matchingLabel) {
            matchingLabel.classList.add('checked');
            matchingLabel.querySelector('input[type="checkbox"]').checked = true;
        }
    }

    const searchInput = document.getElementById('shop-search');
    if (searchParam && searchInput) searchInput.value = searchParam;

    loadAndRenderPage();

    /* ---------- Search (debounced, resets to page 1) ---------- */
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(searchDebounceTimer);
            searchDebounceTimer = setTimeout(() => {
                currentPage = 1;
                loadAndRenderPage();
            }, 350);
        });
    }

    /* ---------- Category filter ---------- */
    document.querySelectorAll('.js-filter-cat').forEach((label) => {
        const checkbox = label.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', () => {
            label.classList.toggle('checked', checkbox.checked);
            currentPage = 1;
            loadAndRenderPage();
        });
    });

    /* ---------- Color filter ---------- */
    document.querySelectorAll('.color-swatch').forEach((swatch) => {
        swatch.setAttribute('aria-pressed', 'false');
        swatch.addEventListener('click', () => {
            const isActive = swatch.classList.toggle('active');
            swatch.setAttribute('aria-pressed', String(isActive));
            currentPage = 1;
            loadAndRenderPage();
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
        });
        priceRange.addEventListener('change', () => {
            currentPage = 1;
            loadAndRenderPage();
        });
    }

    /* ---------- Sort ---------- */
    const sortSelect = document.querySelector('.js-sort');
    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            currentPage = 1;
            loadAndRenderPage();
        });
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
});
