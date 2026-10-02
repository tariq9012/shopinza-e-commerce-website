/* ==========================================================
   Shopinza - checkout.js
   Two-step checkout: shipping form, then payment method
   (COD / Stripe card / JazzCash / Easypaisa). Renders the
   order summary from the Cart module and talks to the
   backend's /api/orders and /api/payments/* endpoints.
   Depends on cart.js and config.js being loaded first, and
   Stripe.js (https://js.stripe.com/v3/) for the card option.
   ========================================================== */

let createdOrderId = null; // reused across retries so we don't double-reserve stock
let createdOrderMethod = null; // the payment method that order currently has on the server
let shippingSnapshot = null;
let stripeInstance = null;
let stripeElements = null;
let stripeCardElement = null;
let appliedCoupon = null; // { code, discount, type, value } - set by applyCoupon() below

function renderCheckoutSummary() {
    const container = document.getElementById('checkout-items-container');
    const subtotalEl = document.getElementById('checkout-subtotal');
    const shippingEl = document.getElementById('checkout-shipping');
    const totalEl = document.getElementById('checkout-total');
    const discountRow = document.getElementById('checkout-discount-row');
    const discountEl = document.getElementById('checkout-discount');
    const couponLabelEl = document.getElementById('checkout-coupon-label');

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
    const discount = appliedCoupon ? appliedCoupon.discount : 0;

    if (discountRow && discountEl) {
        if (appliedCoupon) {
            discountRow.classList.remove('hidden');
            discountEl.textContent = `-${Cart.formatPrice(discount)}`;
            if (couponLabelEl) couponLabelEl.textContent = ` (${appliedCoupon.code})`;
        } else {
            discountRow.classList.add('hidden');
        }
    }

    if (subtotalEl) subtotalEl.textContent = Cart.formatPrice(subtotal);
    if (shippingEl) shippingEl.textContent = shippingCost === 0 ? 'Free' : Cart.formatPrice(shippingCost);
    if (totalEl) totalEl.textContent = Cart.formatPrice(Math.max(subtotal + shippingCost - discount, 0));
}

/** Builds and auto-submits a hidden POST form - used to redirect to JazzCash/Easypaisa's hosted page. */
function submitGatewayRedirectForm(actionUrl, fields) {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = actionUrl;
    Object.entries(fields).forEach(([key, value]) => {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = key;
        input.value = value;
        form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
}

async function initStripeIfNeeded() {
    if (stripeInstance) return true;

    try {
        const config = await Api.get('/payments/config');
        if (!config.stripePublishableKey) {
            return false; // Stripe isn't configured on the backend yet
        }
        if (typeof Stripe === 'undefined') {
            return false; // Stripe.js script failed to load
        }

        stripeInstance = Stripe(config.stripePublishableKey);
        stripeElements = stripeInstance.elements();
        stripeCardElement = stripeElements.create('card', {
            style: {
                base: { color: '#f5f5f7', fontSize: '15px', '::placeholder': { color: '#6b7280' } },
                invalid: { color: '#ff9b9b' },
            },
        });
        stripeCardElement.mount('#stripe-card-element');

        const errorsEl = document.getElementById('stripe-card-errors');
        stripeCardElement.on('change', (event) => {
            if (event.error) {
                errorsEl.textContent = event.error.message;
                errorsEl.classList.remove('hidden');
            } else {
                errorsEl.classList.add('hidden');
            }
        });

        return true;
    } catch (err) {
        return false;
    }
}

function showPaymentError(message) {
    const el = document.getElementById('payment-error');
    if (!el) return;
    if (message) {
        el.textContent = message;
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
}

function showGatewayNote(message) {
    const el = document.getElementById('payment-gateway-note');
    if (!el) return;
    if (message) {
        el.textContent = message;
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    renderCheckoutSummary();

    /* ---------- Coupon code ---------- */
    const couponInput = document.getElementById('coupon-input');
    const applyCouponBtn = document.getElementById('apply-coupon-btn');
    const couponFeedback = document.getElementById('coupon-feedback');

    function showCouponFeedback(message, isSuccess) {
        if (!couponFeedback) return;
        couponFeedback.textContent = message;
        couponFeedback.style.color = isSuccess ? '#8de08d' : '#ff9b9b';
        couponFeedback.classList.remove('hidden');
    }

    function clearAppliedCoupon() {
        appliedCoupon = null;
        if (couponInput) {
            couponInput.disabled = false;
            couponInput.value = '';
        }
        if (applyCouponBtn) {
            applyCouponBtn.textContent = 'Apply';
            delete applyCouponBtn.dataset.applied;
        }
    }

    async function applyCoupon() {
        const code = couponInput.value.trim();
        if (!code) return;

        const subtotal = Cart.getSubtotal();
        applyCouponBtn.disabled = true;
        applyCouponBtn.textContent = 'Applying…';
        if (couponFeedback) couponFeedback.classList.add('hidden');

        try {
            const data = await Api.post('/coupons/validate', { code, subtotal });
            appliedCoupon = { code: data.code, discount: data.discount, type: data.type, value: data.value };
            showCouponFeedback(`"${data.code}" applied — you saved ${Cart.formatPrice(data.discount)}!`, true);
            couponInput.value = data.code;
            couponInput.disabled = true;
            applyCouponBtn.textContent = 'Remove';
            applyCouponBtn.dataset.applied = 'true';
        } catch (err) {
            clearAppliedCoupon();
            showCouponFeedback(err.message, false);
        } finally {
            applyCouponBtn.disabled = false;
            renderCheckoutSummary();
        }
    }

    if (applyCouponBtn && couponInput) {
        applyCouponBtn.addEventListener('click', () => {
            if (applyCouponBtn.dataset.applied === 'true') {
                clearAppliedCoupon();
                if (couponFeedback) couponFeedback.classList.add('hidden');
                renderCheckoutSummary();
            } else {
                applyCoupon();
            }
        });

        couponInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                applyCoupon();
            }
        });
    }

    // If the cart changes (item removed/qty changed) after a coupon was
    // applied, silently re-check it against the new subtotal - a minimum
    // order value or a now-empty cart can make a previously valid coupon
    // invalid.
    document.addEventListener('cart:updated', async () => {
        if (appliedCoupon) {
            try {
                const data = await Api.post('/coupons/validate', {
                    code: appliedCoupon.code,
                    subtotal: Cart.getSubtotal(),
                });
                appliedCoupon.discount = data.discount;
            } catch (err) {
                clearAppliedCoupon();
                showCouponFeedback('Your coupon no longer applies to this cart and was removed.', false);
            }
        }
        renderCheckoutSummary();
    });

    // Pre-fill the email field with the signed-in user's account email
    // (still editable) so they don't have to retype it.
    if (Api.isLoggedIn()) {
        Api.get('/auth/me', { auth: true })
            .then((data) => {
                const emailField = document.getElementById('checkout-email');
                if (emailField && !emailField.value) emailField.value = data.user.email;
            })
            .catch(() => {}); // not critical - the field just stays blank for the user to fill in
    }

    document.querySelectorAll('input[name="shipping_method"]').forEach((radio) => {
        radio.addEventListener('change', renderCheckoutSummary);
    });

    document.querySelectorAll('#shipping-step .shipping-option').forEach((option) => {
        option.addEventListener('click', () => {
            const radio = option.querySelector('input[type="radio"]');
            if (radio) {
                radio.checked = true;
                renderCheckoutSummary();
            }
        });
    });

    /* ---------- Step 1 -> Step 2: Continue to Payment ---------- */
    const continueBtn = document.getElementById('continue-payment-btn');
    const shippingForm = document.getElementById('shipping-address-form');
    const shippingStep = document.getElementById('shipping-step');
    const paymentStep = document.getElementById('payment-step');
    const stepShippingEl = document.getElementById('step-shipping');
    const stepPaymentEl = document.getElementById('step-payment');

    if (continueBtn && shippingForm) {
        continueBtn.addEventListener('click', () => {
            const items = Cart.getItems();

            if (items.length === 0) {
                alert('Your cart is empty. Add a product before checking out.');
                window.location.href = 'shop.html';
                return;
            }

            if (!shippingForm.reportValidity()) return;

            const shippingRadios = document.querySelectorAll('input[name="shipping_method"]');
            const isExpress = shippingRadios.length > 1 && shippingRadios[1].checked;

            shippingSnapshot = {
                shipping: {
                    firstName: document.getElementById('first-name').value.trim(),
                    lastName: document.getElementById('last-name').value.trim(),
                    email: document.getElementById('checkout-email').value.trim(),
                    address: document.getElementById('address').value.trim(),
                    city: document.getElementById('city').value.trim(),
                    state: document.getElementById('state').value,
                    zip: document.getElementById('zip').value.trim(),
                    phone: document.getElementById('phone').value.trim(),
                },
                shippingMethod: isExpress ? 'express' : 'standard',
            };

            shippingStep.classList.add('hidden');
            paymentStep.classList.remove('hidden');

            stepShippingEl.classList.remove('active');
            stepShippingEl.classList.add('done');
            stepShippingEl.querySelector('.step-icon').innerHTML =
                '<span class="material-symbols-outlined" style="font-size:18px">check</span>';
            stepPaymentEl.classList.add('active');

            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    /* ---------- Step 2 -> back to Step 1 ---------- */
    const backBtn = document.getElementById('back-to-shipping-btn');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            paymentStep.classList.add('hidden');
            shippingStep.classList.remove('hidden');
            stepPaymentEl.classList.remove('active');
            stepShippingEl.classList.remove('done');
            stepShippingEl.classList.add('active');
            stepShippingEl.querySelector('.step-icon').textContent = '2';
        });
    }

    /* ---------- Currency policy: JazzCash / Easypaisa charge PKR ---------- */
    // The store is priced in USD (Stripe charges USD). JazzCash/Easypaisa charge PKR at a rate the
    // SERVER is configured with. Without that rate they're disabled - a USD amount is never sent as PKR.
    let gatewayConfig = null;
    try {
        gatewayConfig = await Api.get('/payments/config');
    } catch (err) {
        gatewayConfig = null; // config unreachable: treat PKR methods as unavailable below
    }

    ['jazzcash', 'easypaisa'].forEach((method) => {
        const radio = document.querySelector(`input[name="payment_method"][value="${method}"]`);
        if (!radio) return;
        const info = gatewayConfig && gatewayConfig.gateways && gatewayConfig.gateways[method];
        const subtitle = radio.closest('.shipping-option').querySelector('.subtitle');
        if (!info || !info.available) {
            radio.disabled = true;
            radio.closest('.shipping-option').style.opacity = '0.5';
            if (subtitle) subtitle.textContent = 'Not available right now (not set up for this currency)';
        } else if (subtitle) {
            subtitle.textContent = `Mobile wallet (Pakistan) - charged in PKR at 1 USD = ${info.usdToPkrRate} PKR`;
        }
    });

    /* ---------- Payment method selection ---------- */
    const cardPanel = document.getElementById('stripe-card-panel');
    document.querySelectorAll('input[name="payment_method"]').forEach((radio) => {
        radio.addEventListener('change', async () => {
            showPaymentError('');
            showGatewayNote('');

            if (radio.value === 'stripe' && radio.checked) {
                cardPanel.classList.remove('hidden');
                const ready = await initStripeIfNeeded();
                if (!ready) {
                    cardPanel.classList.add('hidden');
                    showGatewayNote('Card payments are not configured on this server yet. Please choose another payment method.');
                }
            } else {
                cardPanel.classList.add('hidden');
            }
        });
    });

    document.querySelectorAll('#payment-method-options .shipping-option').forEach((option) => {
        option.addEventListener('click', () => {
            const radio = option.querySelector('input[type="radio"]');
            if (radio && !radio.checked) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change'));
            }
        });
    });

    /* ---------- Place Order / Pay Now ---------- */
    const placeOrderBtn = document.getElementById('place-order-btn');
    if (placeOrderBtn) {
        placeOrderBtn.addEventListener('click', async () => {
            const selectedMethod = document.querySelector('input[name="payment_method"]:checked').value;

            // Fail BEFORE creating/reserving an order when a PKR method isn't usable (no rate configured)
            if (selectedMethod === 'jazzcash' || selectedMethod === 'easypaisa') {
                const info = gatewayConfig && gatewayConfig.gateways && gatewayConfig.gateways[selectedMethod];
                if (!info || !info.available) {
                    showPaymentError('This payment method is not configured for this currency yet. Please choose another payment method.');
                    return;
                }
            }

            showPaymentError('');
            placeOrderBtn.disabled = true;
            const originalHTML = placeOrderBtn.innerHTML;
            placeOrderBtn.textContent = selectedMethod === 'cod' ? 'Placing order…' : 'Processing…';

            try {
                // create the order once; retries after a failed payment reuse the same
                // order (and its already-reserved stock) instead of creating a duplicate
                let orderId = createdOrderId;

                if (!orderId) {
                    const items = Cart.getItems();
                    const orderPayload = {
                        // only WHICH product / how many / which variant - the server looks up the
                        // real name, price and image itself and never trusts prices from here
                        items: items.map((item) => ({
                            productId: item.productId || item.id, // older carts saved before variants existed only have `id`
                            qty: item.qty,
                            color: item.color,
                            size: item.size,
                        })),
                        shipping: shippingSnapshot.shipping,
                        shippingMethod: shippingSnapshot.shippingMethod,
                        paymentMethod: selectedMethod,
                        couponCode: appliedCoupon ? appliedCoupon.code : undefined,
                    };

                    const data = await Api.post('/orders', orderPayload, { auth: true });
                    orderId = data.order._id;
                    createdOrderId = orderId;
                    createdOrderMethod = selectedMethod;
                    // secret that proves this browser owns the order (needed for guests) - see OrderAccess in config.js
                    OrderAccess.set(orderId, data.accessToken);
                } else if (createdOrderMethod !== selectedMethod) {
                    // The customer picked a DIFFERENT method for the order that already exists (e.g. declined the
                    // JazzCash PKR confirmation, then chose card). Move the SAME order to the new method on the
                    // server first: no second order, stock and coupon stay reserved exactly once. If the server
                    // says switching isn't safe (e.g. a card payment already went through), the error is shown and
                    // nothing is started.
                    await Api.post(
                        '/payments/switch-method',
                        { orderId, paymentMethod: selectedMethod },
                        { auth: true, headers: OrderAccess.headers(orderId) }
                    );
                    createdOrderMethod = selectedMethod;
                }

                if (selectedMethod === 'cod') {
                    Cart.clear();
                    window.location.href = `order-confirmation.html?orderId=${orderId}&status=success`;
                    return;
                }

                if (selectedMethod === 'stripe') {
                    if (!stripeInstance || !stripeCardElement) {
                        throw new Error('Card payment is not ready yet. Please wait a moment and try again.');
                    }

                    const { clientSecret } = await Api.post(
                        '/payments/stripe/create-intent',
                        { orderId },
                        { auth: true, headers: OrderAccess.headers(orderId) }
                    );

                    const result = await stripeInstance.confirmCardPayment(clientSecret, {
                        payment_method: {
                            card: stripeCardElement,
                            billing_details: {
                                name: `${shippingSnapshot.shipping.firstName} ${shippingSnapshot.shipping.lastName}`,
                            },
                        },
                    });

                    if (result.error) {
                        throw new Error(result.error.message);
                    }

                    // Defense in depth / local-dev fallback: ask the SERVER to re-verify
                    // the payment with Stripe directly (in production the webhook does
                    // this too, but that can't reach a localhost dev server).
                    await Api.post(`/payments/stripe/confirm/${orderId}`, {}, { auth: true, headers: OrderAccess.headers(orderId) });

                    Cart.clear();
                    window.location.href = `order-confirmation.html?orderId=${orderId}&status=success`;
                    return;
                }

                if (selectedMethod === 'jazzcash' || selectedMethod === 'easypaisa') {
                    const { actionUrl, fields, display } = await Api.post(
                        `/payments/${selectedMethod}/initiate`,
                        { orderId },
                        { auth: true, headers: OrderAccess.headers(orderId) }
                    );

                    // The customer must see the EXACT currency and amount the provider will charge
                    // BEFORE being redirected. Declining leaves the order unpaid (it is released
                    // automatically if it stays unpaid).
                    const providerName = selectedMethod === 'jazzcash' ? 'JazzCash' : 'Easypaisa';
                    const ok = window.confirm(
                        `${providerName} will charge ${display.amount}.\n\nYour order total is ${display.orderTotal} (1 USD = ${display.rate} PKR).\n\nContinue to ${providerName}?`
                    );
                    if (!ok) {
                        throw new Error(`Payment not started - nothing was charged. Your order is on hold: press the button again to pay with ${providerName}, or pick a different payment method (your order is kept and switched safely, no duplicate order is created).`);
                    }

                    Cart.clear();
                    submitGatewayRedirectForm(actionUrl, fields);
                    return; // browser is navigating away to the gateway now
                }
            } catch (err) {
                showPaymentError(err.message);
                placeOrderBtn.disabled = false;
                placeOrderBtn.innerHTML = originalHTML;
            }
        });
    }
});
