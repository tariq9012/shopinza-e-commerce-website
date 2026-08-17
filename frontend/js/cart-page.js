/* ==========================================================
   Shopinza - cart-page.js
   Renders the cart items table and order summary on cart.html
   from the Cart module (localStorage). Depends on cart.js.
   ========================================================== */

function renderCartItem(item) {
    const wrapper = document.createElement('div');
    wrapper.className = 'cart-item';
    wrapper.dataset.id = item.id;

    wrapper.innerHTML = `
        <div class="cart-item-image">
            <img src="${item.image}" alt="${item.name}" />
        </div>
        <div class="cart-item-details">
            <div class="cart-item-top">
                <div>
                    <h3>${item.name}</h3>
                </div>
                <span class="cart-item-price">${Cart.formatPrice(item.price * item.qty)}</span>
            </div>
            <div class="cart-item-bottom">
                <div class="qty-control-dark">
                    <button class="js-qty-minus" aria-label="Decrease quantity"><span class="material-symbols-outlined">remove</span></button>
                    <span>${item.qty}</span>
                    <button class="js-qty-plus" aria-label="Increase quantity"><span class="material-symbols-outlined">add</span></button>
                </div>
                <button class="remove-btn js-remove-item"><span class="material-symbols-outlined">delete</span> Remove</button>
            </div>
        </div>
    `;

    wrapper.querySelector('.js-qty-plus').addEventListener('click', () => {
        Cart.incrementQty(item.id);
        renderCartPage();
    });

    wrapper.querySelector('.js-qty-minus').addEventListener('click', () => {
        Cart.decrementQty(item.id);
        renderCartPage();
    });

    wrapper.querySelector('.js-remove-item').addEventListener('click', () => {
        Cart.removeItem(item.id);
        renderCartPage();
    });

    return wrapper;
}

function renderCartPage() {
    const container = document.getElementById('cart-items-container');
    const itemCountEl = document.getElementById('summary-item-count');
    const subtotalEl = document.getElementById('summary-subtotal');
    const totalEl = document.getElementById('summary-total');
    const checkoutBtn = document.getElementById('checkout-btn');

    if (!container) return;

    const items = Cart.getItems();
    container.innerHTML = '';

    if (items.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding: 48px 24px; background-color:#171a24; border:1px solid #262a37; border-radius:12px;">
                <span class="material-symbols-outlined" style="font-size:40px; color:#9a9aa5;">shopping_cart</span>
                <p style="color:#f5f5f7; font-weight:600; margin-top:12px;">Your cart is empty</p>
                <p style="color:#9a9aa5; font-size:14px; margin-top:4px;">Add a few things you like and they'll show up here.</p>
                <a href="shop.html" class="a"><button class="btn-checkout" style="margin-top:20px; display:inline-flex; width:auto; padding:12px 24px;">Browse Products</button></a>
            </div>
        `;
    } else {
        items.forEach((item) => container.appendChild(renderCartItem(item)));
    }

    const count = Cart.getCount();
    const subtotal = Cart.getSubtotal();

    if (itemCountEl) itemCountEl.textContent = `Subtotal (${count} item${count === 1 ? '' : 's'})`;
    if (subtotalEl) subtotalEl.textContent = Cart.formatPrice(subtotal);
    if (totalEl) totalEl.textContent = Cart.formatPrice(subtotal);

    if (checkoutBtn) {
        checkoutBtn.disabled = items.length === 0;
        checkoutBtn.style.opacity = items.length === 0 ? '0.5' : '1';
        checkoutBtn.style.pointerEvents = items.length === 0 ? 'none' : 'auto';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    renderCartPage();

    const promoBtn = document.getElementById('promo-apply-btn');
    if (promoBtn) {
        promoBtn.addEventListener('click', (event) => {
            event.preventDefault();
            const input = document.getElementById('promo');
            if (input && input.value.trim()) {
                alert('Promo codes will be validated once the backend is connected. Code noted: ' + input.value.trim());
            }
        });
    }

    document.addEventListener('cart:updated', renderCartPage);
});
