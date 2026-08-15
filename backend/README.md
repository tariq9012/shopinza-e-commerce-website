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

3. (Optional) Seed the products collection with the demo products already in the HTML:
   ```
   npm run seed
   ```

4. Start the server:
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

## Notes

- Passwords are hashed with bcrypt before being saved — never stored in plain text.
- JWT tokens expire after 7 days.
- The cart itself still lives in the browser's `localStorage` (via `js/cart.js`)
  right up until checkout, where it's sent to `/api/orders` to create the order.
- CORS is restricted to the origins listed in `CLIENT_ORIGIN` in `.env`.
