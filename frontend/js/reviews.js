/* ==========================================================
   Shopinza - reviews.js
   Loads and renders reviews for the product shown on
   product-details.html (?slug=...), handles eligibility
   checks, review submission (with optional photos), and
   deleting your own review.
   Depends on config.js and cart.js (for escapeHtml via
   products.js) being loaded first.
   ========================================================== */

let reviewsCache = [];
let currentReviewUser = null; // { _id, firstName, ... } - null if signed out
let selectedReviewImages = []; // [{ url, publicId }]
let isReviewImageUploading = false;

function getSlugFromUrlForReviews() {
    const params = new URLSearchParams(window.location.search);
    return params.get('slug');
}

function reviewStarsHtml(rating) {
    const full = Math.round(rating);
    let html = '';
    for (let i = 1; i <= 5; i++) {
        html += `<span class="material-symbols-outlined review-star${i <= full ? ' filled' : ''}">star</span>`;
    }
    return html;
}

function formatReviewDate(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderReviewsSummary() {
    const summaryEl = document.getElementById('pd-reviews-rating-summary');
    const tabCountEl = document.getElementById('pd-review-count');
    const heroRatingEl = document.getElementById('pd-rating');
    if (!summaryEl) return;

    const count = reviewsCache.length;
    const avg = count === 0 ? 0 : reviewsCache.reduce((sum, r) => sum + r.rating, 0) / count;
    const avgRounded = Math.round(avg * 10) / 10;

    summaryEl.innerHTML = `
        ${reviewStarsHtml(avg)}
        <span class="rating-count">${avgRounded.toFixed(1)} out of 5 (${count} review${count === 1 ? '' : 's'})</span>
    `;

    if (tabCountEl) tabCountEl.textContent = count;

    if (heroRatingEl) {
        heroRatingEl.innerHTML = `
            ${typeof Products !== 'undefined' ? Products.ratingStars(avg) : ''}
            <span class="rating-count">${avgRounded.toFixed(1)} (${count} review${count === 1 ? '' : 's'})</span>
        `;
    }
}

function renderReviewList() {
    const listEl = document.getElementById('pd-review-list');
    if (!listEl) return;

    if (reviewsCache.length === 0) {
        listEl.innerHTML = `<p class="loading-note">No reviews yet — be the first to share your experience.</p>`;
        return;
    }

    listEl.innerHTML = reviewsCache
        .map((review) => {
            const reviewer = review.user;
            const firstName = reviewer ? reviewer.firstName : 'Shopinza';
            const lastInitial = reviewer && reviewer.lastName ? `${reviewer.lastName.charAt(0)}.` : '';
            const isOwn = currentReviewUser && reviewer && String(reviewer._id) === String(currentReviewUser._id);

            const imagesHtml = (review.images || []).length
                ? `<div class="review-images">
                        ${review.images.map((src) => `<img src="${escapeHtml(src)}" alt="Review photo" />`).join('')}
                   </div>`
                : '';

            return `
                <div class="review-card" data-review-id="${review._id}">
                    <div class="review-card-header">
                        <div class="review-avatar">${escapeHtml(firstName.charAt(0))}</div>
                        <div class="review-meta">
                            <strong>${escapeHtml(firstName)} ${escapeHtml(lastInitial)}</strong>
                            ${review.verifiedPurchase ? '<span class="verified-badge"><span class="material-symbols-outlined">verified</span> Verified Purchase</span>' : ''}
                            <div class="review-stars">${reviewStarsHtml(review.rating)}</div>
                        </div>
                        <span class="review-date">${formatReviewDate(review.createdAt)}</span>
                        ${isOwn ? `<button type="button" class="review-delete-btn js-delete-review" data-id="${review._id}" title="Delete your review"><span class="material-symbols-outlined">delete</span></button>` : ''}
                    </div>
                    <p class="review-comment">${escapeHtml(review.comment)}</p>
                    ${imagesHtml}
                </div>
            `;
        })
        .join('');

    listEl.querySelectorAll('.js-delete-review').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('Delete your review? This cannot be undone.')) return;
            try {
                await Api.request(`/reviews/${btn.dataset.id}`, { method: 'DELETE', auth: true });
                await loadReviews();
                await loadEligibility();
            } catch (err) {
                alert(err.message);
            }
        });
    });
}

async function loadReviews() {
    const slug = getSlugFromUrlForReviews();
    if (!slug) return;

    try {
        const data = await Api.get(`/reviews/${slug}`);
        reviewsCache = data.reviews || [];
        renderReviewsSummary();
        renderReviewList();
    } catch (err) {
        const listEl = document.getElementById('pd-review-list');
        if (listEl) listEl.innerHTML = `<p class="loading-note">Could not load reviews: ${err.message}</p>`;
    }
}

async function loadEligibility() {
    const slug = getSlugFromUrlForReviews();
    const form = document.getElementById('review-form');
    const note = document.getElementById('review-eligibility-note');
    if (!slug || !form || !note) return;

    if (!Api.isLoggedIn()) {
        form.classList.add('hidden');
        note.textContent = 'Log in to write a review — reviews are only open to customers who purchased this product.';
        note.classList.remove('hidden');
        return;
    }

    try {
        const data = await Api.get(`/reviews/${slug}/can-review`, { auth: true });

        if (data.canReview) {
            form.classList.remove('hidden');
            note.classList.add('hidden');
        } else {
            form.classList.add('hidden');
            note.classList.remove('hidden');
            note.textContent = data.alreadyReviewed
                ? "You've already reviewed this product."
                : 'Only customers who purchased this product can leave a review.';
        }
    } catch (err) {
        form.classList.add('hidden');
        note.classList.remove('hidden');
        note.textContent = err.message;
    }
}

async function loadCurrentReviewUser() {
    if (!Api.isLoggedIn()) {
        currentReviewUser = null;
        return;
    }
    try {
        const data = await Api.get('/auth/me', { auth: true });
        currentReviewUser = data.user;
    } catch (err) {
        currentReviewUser = null;
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    if (!document.getElementById('pd-review-list')) return; // not on the product page

    await loadCurrentReviewUser();
    await loadReviews();
    await loadEligibility();

    /* ---------- Star rating input ---------- */
    const starInput = document.getElementById('review-star-input');
    const ratingHidden = document.getElementById('review-rating-value');

    if (starInput) {
        const starButtons = Array.from(starInput.querySelectorAll('.star-btn'));

        function paintStars(value) {
            starButtons.forEach((btn) => {
                btn.classList.toggle('active', Number(btn.dataset.value) <= value);
            });
        }

        starButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                ratingHidden.value = btn.dataset.value;
                paintStars(Number(btn.dataset.value));
            });
            btn.addEventListener('mouseenter', () => paintStars(Number(btn.dataset.value)));
        });

        starInput.addEventListener('mouseleave', () => paintStars(Number(ratingHidden.value)));
    }

    /* ---------- Review photo upload ---------- */
    const imageInput = document.getElementById('review-images');
    const imageStatus = document.getElementById('review-image-status');
    const imagePreviewWrap = document.getElementById('review-image-preview-wrap');

    function renderReviewImagePreview() {
        imagePreviewWrap.querySelectorAll('img.thumb').forEach((img) => img.remove());
        selectedReviewImages.forEach((img, index) => {
            const thumb = document.createElement('img');
            thumb.className = 'thumb';
            thumb.src = img.url;
            thumb.title = 'Click to remove';
            thumb.style.cursor = 'pointer';
            thumb.addEventListener('click', () => {
                selectedReviewImages.splice(index, 1);
                renderReviewImagePreview();
            });
            imagePreviewWrap.insertBefore(thumb, imageStatus);
        });
    }

    if (imageInput) {
        imageInput.addEventListener('change', async () => {
            const files = Array.from(imageInput.files);
            if (files.length === 0) return;

            if (selectedReviewImages.length + files.length > 4) {
                imageStatus.textContent = 'You can attach up to 4 photos.';
                imageStatus.className = 'upload-status error';
                imageInput.value = '';
                return;
            }

            isReviewImageUploading = true;
            imageStatus.textContent = `Uploading ${files.length} photo(s)…`;
            imageStatus.className = 'upload-status uploading';

            try {
                const uploaded = await Api.uploadImagesDirect(files, 'review');
                selectedReviewImages = selectedReviewImages.concat(uploaded);
                renderReviewImagePreview();
                imageStatus.textContent = 'Uploaded ✓';
                imageStatus.className = 'upload-status success';
            } catch (err) {
                imageStatus.textContent = err.message;
                imageStatus.className = 'upload-status error';
            } finally {
                isReviewImageUploading = false;
                imageInput.value = '';
            }
        });
    }

    /* ---------- Submit review ---------- */
    const form = document.getElementById('review-form');
    const feedback = document.getElementById('review-form-feedback');

    if (form) {
        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            feedback.classList.add('hidden');

            const slug = getSlugFromUrlForReviews();
            const rating = Number(ratingHidden.value);
            const comment = document.getElementById('review-comment').value.trim();

            if (isReviewImageUploading) {
                feedback.textContent = 'Please wait for photo upload to finish.';
                feedback.classList.remove('hidden');
                return;
            }
            if (!rating) {
                feedback.textContent = 'Please select a star rating.';
                feedback.classList.remove('hidden');
                return;
            }
            if (!comment) {
                feedback.textContent = 'Please write a few words about your experience.';
                feedback.classList.remove('hidden');
                return;
            }

            const submitBtn = document.getElementById('review-submit-btn');
            submitBtn.disabled = true;
            submitBtn.textContent = 'Submitting…';

            try {
                await Api.post(
                    '/reviews',
                    {
                        productSlug: slug,
                        rating,
                        comment,
                        images: selectedReviewImages.map((img) => img.url),
                    },
                    { auth: true }
                );

                form.reset();
                ratingHidden.value = '0';
                if (starInput) starInput.querySelectorAll('.star-btn').forEach((b) => b.classList.remove('active'));
                selectedReviewImages = [];
                renderReviewImagePreview();

                await loadReviews();
                await loadEligibility();
            } catch (err) {
                feedback.textContent = err.message;
                feedback.classList.remove('hidden');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Submit Review';
            }
        });
    }
});
