/* ==========================================================
   Shopinza - checkout.js
   Interactivity for checkout.html: renders the order summary
   from the Cart module, validates the shipping form, and
   submits the order to the backend (POST /api/orders).
   Depends on cart.js and config.js being loaded first.
   ========================================================== */

function renderCheckoutSummary() {
    const container = document.getElementById('checkout-items-container');
    const subtotalEl = document.getElementById('checkout-subtotal');
    const shippingEl = document.getElementById('checkout-shipping');
    const totalEl = document.getElementById('checkout-total');

    if (!container) return;

    const items = Cart.getItems();
    container.innerHTML = '';

    if (items.length === 0) {
        container.innerHTML = '<p style="color:#9a9aa5; font-size:14px;">Your cart is empty. <a href="shop.html" style="color:#c4c1fb;">Go shopping</a> first.</p>';
    } else {
        items.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'summary-item';
            row.innerHTML = `
                <img src="${item.image}" alt="${item.name}" />
                <div class="summary-item-info">
                    <span class="name">${item.name}</span>
                    Qty ${item.qty} · ${Cart.formatPrice(item.price)}
                </div>
            `;
            container.appendChild(row);
        });
    }

    const subtotal = Cart.getSubtotal();
    const shippingRadios = document.querySelectorAll('input[name="shipping_method"]');
    const isExpress = shippingRadios.length > 1 && shippingRadios[1].checked;
    const shippingCost = isExpress ? 25 : 0;

    if (subtotalEl) subtotalEl.textContent = Cart.formatPrice(subtotal);
    if (shippingEl) shippingEl.textContent = shippingCost === 0 ? 'Free' : Cart.formatPrice(shippingCost);
    if (totalEl) totalEl.textContent = Cart.formatPrice(subtotal + shippingCost);
}

document.addEventListener('DOMContentLoaded', () => {
    renderCheckoutSummary();
    document.addEventListener('cart:updated', renderCheckoutSummary);

    document.querySelectorAll('input[name="shipping_method"]').forEach((radio) => {
        radio.addEventListener('change', renderCheckoutSummary);
    });

    document.querySelectorAll('.shipping-option').forEach((option) => {
        option.addEventListener('click', () => {
            const radio = option.querySelector('input[type="radio"]');
            if (radio) {
                radio.checked = true;
                renderCheckoutSummary();
            }
        });
    });

    const continueBtn = document.getElementById('continue-payment-btn');
    const shippingForm = document.getElementById('shipping-address-form');

    if (continueBtn && shippingForm) {
        continueBtn.addEventListener('click', async () => {
            const items = Cart.getItems();

            if (items.length === 0) {
                alert('Your cart is empty. Add a product before checking out.');
                window.location.href = 'shop.html';
                return;
            }

            if (!shippingForm.reportValidity()) {
                return;
            }

            const shippingRadios = document.querySelectorAll('input[name="shipping_method"]');
            const isExpress = shippingRadios.length > 1 && shippingRadios[1].checked;

            const orderPayload = {
                items: items.map((item) => ({
                    productId: item.id,
                    name: item.name,
                    price: item.price,
                    image: item.image,
                    qty: item.qty,
                })),
                shipping: {
                    firstName: document.getElementById('first-name').value.trim(),
                    lastName: document.getElementById('last-name').value.trim(),
                    address: document.getElementById('address').value.trim(),
                    city: document.getElementById('city').value.trim(),
                    state: document.getElementById('state').value,
                    zip: document.getElementById('zip').value.trim(),
                    phone: document.getElementById('phone').value.trim(),
                },
                shippingMethod: isExpress ? 'express' : 'standard',
            };

            continueBtn.disabled = true;
            const originalHTML = continueBtn.innerHTML;
            continueBtn.textContent = 'Placing order…';

            try {
                const data = await Api.post('/orders', orderPayload, { auth: true });

                // order placed successfully - clear the cart and remember the order id
                Cart.clear();
                localStorage.setItem('shopinza_last_order_id', data.order._id);

                alert(
                    `Order placed! Your order ID is ${data.order._id}.\n\n` +
                    `Payment collection isn't wired up yet — that's the next backend step ` +
                    `(Stripe/JazzCash/Easypaisa integration).`
                );
                window.location.href = 'index.html';
            } catch (err) {
                alert(err.message);
                continueBtn.disabled = false;
                continueBtn.innerHTML = originalHTML;
            }
        });
    }
});
