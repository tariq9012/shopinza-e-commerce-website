# Shopinza Backend API

Node.js + Express + MongoDB backend for the Shopinza e-commerce frontend.
Handles auth, orders/checkout, contact form, newsletter signups, and products.

## Setup

1. Install dependencies:
   ```
   cd backend
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your own values:
   ```
   cp .env.example .env
   ```
   - `MONGO_URI` — your MongoDB connection string (local MongoDB or MongoDB Atlas)
   - `JWT_SECRET` — any long random string
   - `CLIENT_ORIGIN` — the URL(s) your frontend runs on (comma-separated)
   - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` — from your
     [Cloudinary dashboard](https://console.cloudinary.com) (free tier is enough).
     Product image uploads in the admin panel won't work until these are set.

3. (Optional) Seed the products collection with the demo products already in the HTML:
   ```
   npm run seed
   ```

4. Create your admin account: sign up normally on the website (login.html → Sign Up),
   then promote that account to admin:
   ```
   npm run make-admin your-email@example.com
   ```
   Sign in again at `login.html` — you'll be redirected to `admin/dashboard.html`.

5. Start the server:
   ```
   npm run dev
   ```
   The API will run at `http://localhost:5000`.

## Connecting the frontend

Open `js/config.js` in the frontend and set `API_BASE_URL` to where this
server is running (defaults to `http://localhost:5000/api`).

## API Reference

### Auth
| Method | Route | Body | Auth | Description |
|---|---|---|---|---|
| POST | `/api/auth/register` | `{ firstName, lastName, email, password }` | — | Create an account, returns `{ token, user }` |
| POST | `/api/auth/login` | `{ email, password }` | — | Sign in, returns `{ token, user }` |
| GET | `/api/auth/me` | — | Bearer token | Returns the signed-in user |

### Products
| Method | Route | Query | Description |
|---|---|---|---|
| GET | `/api/products` | `?category=Electronics&sort=price_asc` | List products |
| GET | `/api/products/:slug` | — | Get a single product |

### Orders
| Method | Route | Body | Auth | Description |
|---|---|---|---|---|
| POST | `/api/orders` | `{ items, shipping, shippingMethod }` | Optional | Create an order (checkout) |
| GET | `/api/orders/mine` | — | Bearer token | List the signed-in user's orders |
| GET | `/api/orders/:id` | — | — | Look up a single order (order confirmation) |

### Contact
| Method | Route | Body | Description |
|---|---|---|---|
| POST | `/api/contact` | `{ name, email, subject, message }` | Save a contact message |

### Newsletter
| Method | Route | Body | Description |
|---|---|---|---|
| POST | `/api/newsletter` | `{ email }` | Subscribe an email address |

### Uploads (require a Bearer token)
| Method | Route | Body | Auth | Description |
|---|---|---|---|---|
| POST | `/api/upload` | form-data: `image` (single file) | Admin | Uploads a product's main image, returns `{ url, publicId }` |
| POST | `/api/upload/multiple` | form-data: `images` (up to 6 files) | Admin | Uploads a product's gallery images, returns `{ images: [{ url, publicId }] }` |
| POST | `/api/upload/review` | form-data: `images` (up to 4 files) | Any signed-in user | Uploads review photos, returns `{ images: [{ url, publicId }] }` |

### Reviews
| Method | Route | Body | Auth | Description |
|---|---|---|---|---|
| GET | `/api/reviews/:slug` | — | — | List all reviews for a product, newest first |
| GET | `/api/reviews/:slug/can-review` | — | Bearer token | Checks if the signed-in user purchased this product and hasn't already reviewed it |
| POST | `/api/reviews` | `{ productSlug, rating, comment, images }` | Bearer token | Create a review — requires a paid/shipped/delivered order containing this product |
| PUT | `/api/reviews/:id` | `{ rating, comment, images }` | Bearer token (owner) | Edit your own review |
| DELETE | `/api/reviews/:id` | — | Bearer token (owner or admin) | Delete a review |

### Payments
| Method | Route | Body | Description |
|---|---|---|---|
| GET | `/api/payments/config` | — | Public Stripe publishable key for the frontend |
| POST | `/api/payments/stripe/create-intent` | `{ orderId }` | Creates a Stripe PaymentIntent for the order's stored total |
| POST | `/api/payments/stripe/confirm/:orderId` | — | Re-verifies payment status with Stripe and marks the order paid (local-dev fallback for the webhook) |
| POST | `/api/payments/stripe/webhook` | (raw Stripe event) | Stripe calls this in production; verifies the signature and marks the order paid |
| POST | `/api/payments/jazzcash/initiate` | `{ orderId }` | Returns the hashed form fields to redirect the customer to JazzCash |
| POST | `/api/payments/jazzcash/callback` | (form POST from JazzCash) | Verifies the secure hash and marks the order paid |
| POST | `/api/payments/easypaisa/initiate` | `{ orderId }` | Returns the hashed form fields to redirect the customer to Easypaisa |
| POST | `/api/payments/easypaisa/callback` | (form POST from Easypaisa) | Verifies the secure hash and marks the order paid |

**Setting up Stripe (card payments):**
1. Create a free account at [dashboard.stripe.com](https://dashboard.stripe.com) — no business verification needed for test mode.
2. Copy your test **Secret key** and **Publishable key** from Developers → API keys into `.env`.
3. For local testing, install the [Stripe CLI](https://docs.stripe.com/stripe-cli) and run `stripe listen --forward-to localhost:5000/api/payments/stripe/webhook` — it prints a `whsec_...` value for `STRIPE_WEBHOOK_SECRET`. (You can also skip the webhook for local dev — the frontend already calls `/stripe/confirm/:orderId` as a fallback that re-checks the payment with Stripe directly.)
4. Use Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.

**Setting up JazzCash / Easypaisa:**
These require your own sandbox merchant account — register at their merchant portals to get a Merchant/Store ID, password, and integrity/hash salt, then add them to `.env`. The integration (`routes/paymentRoutes.js`) follows their publicly documented hash-based redirect format, but **has not been tested against a live JazzCash/Easypaisa endpoint** since that needs real sandbox credentials — double-check field names against the exact docs you receive during onboarding.

### Admin (all require a Bearer token from an "admin" role user)
| Method | Route | Body | Description |
|---|---|---|---|
| GET | `/api/admin/stats` | — | Dashboard overview numbers |
| POST | `/api/products` | product fields | Create a product |
| PUT | `/api/products/id/:id` | product fields | Update a product |
| DELETE | `/api/products/id/:id` | — | Delete a product |
| GET | `/api/orders/admin/all` | `?status=pending` | List every order |
| PATCH | `/api/orders/admin/:id/status` | `{ status }` | Update an order's status |
| GET | `/api/contact` | — | List contact messages |
| PATCH | `/api/contact/:id/resolve` | — | Toggle a message's resolved state |

## Notes

- Passwords are hashed with bcrypt before being saved — never stored in plain text.
- JWT tokens expire after 7 days.
- The cart itself still lives in the browser's `localStorage` (via `js/cart.js`)
  right up until checkout, where it's sent to `/api/orders` to create the order.
- CORS is restricted to the origins listed in `CLIENT_ORIGIN` in `.env`.
- A product's `rating` and `reviewCount` fields are recalculated automatically
  every time a review is created, edited, or deleted (see `routes/reviewRoutes.js`).
  Reviews require a verified purchase: the reviewer must have an order with
  status `paid`, `shipped`, or `delivered` containing that product's slug.
- Placing an order reserves stock immediately (before payment completes), so
  that two customers can never both "win" the last item. If a Stripe/JazzCash/
  Easypaisa order is never actually paid for, `jobs/cancelAbandonedOrders.js`
  automatically cancels it and gives the stock back after `ORDER_ABANDON_MINUTES`
  (default 30) — this runs on a timer started in `server.js`, checking every
  `ORDER_CLEANUP_INTERVAL_MINUTES` (default 10). COD orders are never touched by
  this job — staying "pending" until delivery is normal for COD.