# Deploying Shopinza on Vercel (one project, one domain)

`frontend/` (static site) and `backend/` (Express + Socket.IO) deploy together as ONE
Vercel project using **Vercel Services** (Beta). `vercel.json` at the repo root wires it up:

| Public path        | Goes to  |
| ------------------ | -------- |
| `/api/*`           | backend  |
| `/socket.io/*`     | backend  |
| everything else    | frontend |

## Vercel dashboard settings
1. Import the GitHub repo. **Root Directory: leave as the repo root** (do NOT pick `frontend`).
2. **Framework Preset: Services** (Settings -> Build and Deployment). Without it, `services` in vercel.json is ignored.
3. Node.js Version: 24.x. Fluid Compute: ON (default for new projects; WebSockets need it).
4. Add the environment variables below (Production + Preview).
5. Deploy. Then set `FRONTEND_URL`/`CLIENT_ORIGIN` to the final URL and redeploy.

## Environment variable NAMES (values go only in the Vercel dashboard)
Required: `MONGO_URI`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CRON_SECRET`, `FRONTEND_URL`
Also required: `ORDER_TRACKING_SECRET` (signs guest email tracking links). Needed only for JazzCash/Easypaisa: `USD_TO_PKR_RATE`.
Recommended: `REDIS_URL` (a `rediss://` URL, e.g. Upstash / Redis from the Vercel Marketplace) - see "Redis" below
Images: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
Stripe: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
Email: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`
Optional: `CLIENT_ORIGIN` (leave EMPTY on Vercel - same origin only; set it only if another site must call the API), `ORDER_ABANDON_MINUTES`,
`JAZZCASH_MERCHANT_ID`, `JAZZCASH_PASSWORD`, `JAZZCASH_INTEGRITY_SALT`, `JAZZCASH_SANDBOX_URL`, `JAZZCASH_RETURN_URL`,
`EASYPAISA_STORE_ID`, `EASYPAISA_HASH_KEY`, `EASYPAISA_SANDBOX_URL`, `EASYPAISA_RETURN_URL`,
`GOOGLE_CLIENT_ID`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`
Not needed on Vercel: `PORT`, `ORDER_CLEANUP_INTERVAL_MINUTES`.
`FRONTEND_URL` = `https://<your-domain>` (no trailing slash, no `/frontend`).

## After the first deploy
- Stripe Dashboard -> Webhooks: endpoint `https://<your-domain>/api/payments/stripe/webhook`.
- Google/Facebook login: add `https://<your-domain>` to authorised origins; put the IDs in `frontend/js/config.js` as before.
- MongoDB Atlas -> Network Access: allow Vercel (0.0.0.0/0 unless you use a static-IP plan).
- JazzCash / Easypaisa return URLs -> `https://<your-domain>/...`.

## Scheduled cleanup (abandoned online-payment orders)
Production no longer uses `setInterval`. `vercel.json` has a cron that calls
`GET /api/cron/cancel-abandoned-orders` (same `cancelAbandonedOrders()` logic), secured by `CRON_SECRET`.
- Schedule now: `0 3 * * *` (daily, the most the Hobby plan allows; Vercel may run it any time in that hour).
- After upgrading to Pro: change `schedule` to `*/10 * * * *` in `vercel.json`. Nothing else changes.
- Trade-off on Hobby: an abandoned Stripe/JazzCash/Easypaisa order keeps its reserved stock until the next daily run.
- Local dev (`npm run dev`) still uses the 10-minute `setInterval`.

## Local testing
```bash
cd backend && cp .env.example .env   # fill in real values (never commit .env)
npm install
npm run dev                           # API on :5000 (old workflow: frontend via Live Server :5501)

# Vercel-style (frontend + backend on one origin):
npm i -g vercel
vercel dev -L                         # from the repo root -> http://localhost:3000
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/cancel-abandoned-orders
```
`frontend/js/config.js` uses same-origin `/api` everywhere except a separate local frontend
(Live Server / file://), which talks to `http://localhost:5000`.

## Socket.IO on Vercel - what is instance-local (Phase 1 audit)
Rooms live in each function instance's memory; Vercel may run several instances and pins each
WebSocket connection to one of them.
1. **Order live tracking** (`order:updated`): the event is emitted from the HTTP request that changes the
   status (admin update, self-cancel, Stripe webhook / payment confirm). If that request runs on a different
   instance than the customer's socket, **the update is missed**. Needs Redis (adapter/pub-sub) to be reliable.
2. **"X people viewing"** (`product:viewers`): counts are per instance, so it can **undercount**. Needs Redis.
3. **Reconnects lose rooms**: Vercel closes WebSockets at the function's max duration; Socket.IO reconnects
   automatically, but `frontend/js/orders.js` / `product.js` only join rooms once on page load and never re-join
   after a reconnect, so live updates would silently stop. Small client fix (re-emit joins on `connect`) - recommended for Phase 2.
4. Pages still show correct data on refresh - only the *live push* is affected.
5. Client uses `transports: ['websocket']` because Vercel's WebSocket docs require it (polling can hit different instances).

## Other Vercel limits worth knowing
- Request bodies are capped (about 4.5 MB). Admin image upload allows 5 MB per file and 6 files, so larger uploads will fail with 413 on Vercel.
- If MongoDB is unreachable the API answers 503 after about 10 s (server-selection timeout) instead of crashing.
- WebSockets and Services are both **Beta** on Vercel.

---

# Phase 2 - security hardening

## What changed (and why)
| Area | Before | Now |
| --- | --- | --- |
| Checkout prices | client sent price/name/image; qty unchecked (a negative qty even INCREASED stock) | client sends only product + qty + variant; name, price, image, discount, shipping and total are computed on the server from MongoDB, in integer cents. qty must be a whole number 1-20 |
| Order privacy | `GET /api/orders/:id` was public | only the signed-in owner, an admin, or the browser holding the order's secret token (`X-Order-Token`, returned once at checkout) - everyone else gets 404 |
| Payment endpoints | anyone with an order id could start/confirm a payment | same ownership check |
| Easypaisa | an unsigned POST of `status=SUCCESS` marked any order paid | fails CLOSED: needs a valid hash + matching order, amount and success status (see "Easypaisa" below) |
| JazzCash | hash only | + constant-time compare, OUR transaction reference, and amount must match the order total |
| Stripe | webhook trusted the metadata | PaymentIntent must match the order (id, amount, currency); one PaymentIntent is reused per order; idempotency key on creation; webhook returns 500 on a real failure so Stripe retries |
| "Paid" transition | read-then-write | one atomic conditional update: webhook + confirm + retries pay the order exactly once (one email, one live push) |
| Cancel / status | any status -> any status; cancelled orders could be revived and restocked twice | transition table (`utils/orderStatus.js`); cancel is an atomic "only if still cancellable" flip, so stock and the coupon redemption are restored exactly once |
| Payment after cancel | silently marked paid without re-reserving stock | order stays cancelled and is flagged `paymentIssue` for a manual refund |
| Auth | plain checks | every field must be a real string (blocks `{"$gt": ""}` injection), email format, length caps, JWT algorithm pinned to HS256, rate limits |
| HTTP | open CORS when `CLIENT_ORIGIN` empty | Helmet; production CORS = same origin (+ `CLIENT_ORIGIN`) only; 200 KB JSON limit; malformed JSON -> 400 not 500 |
| Rate limits | none | api 300/min, auth 20/15 min, order creation 20/hour, payments 60/15 min, contact/newsletter 10/hour (shared across instances via Redis when `REDIS_URL` is set - proven by an automated two-process test) |
| XSS | order names/emails rendered as raw HTML in the admin dashboard, order pages and review photos | escaped; review image URLs must be Cloudinary HTTPS URLs |
| Socket.IO | anyone could join any order room by id | joining needs the login token (owner) or the order token; origin checked; payload sizes/rooms capped; **rooms are re-joined after every reconnect** |
| Uploads | multipart through the server (Vercel 4.5 MB body limit) | the browser uploads straight to Cloudinary with a short-lived server signature (`POST /api/upload/sign`). Cloudinary enforces the signed folder + allowed formats; **the 10 MB size is only checked in the browser** (Cloudinary has no per-request size parameter - your Cloudinary plan's own file-size limit is the real ceiling); signing is rate-limited per user |
| Social login | ids hard-coded in `config.js` | read from the API (`GOOGLE_CLIENT_ID`, `FACEBOOK_APP_ID` env variables) - only the two PUBLIC ids are exposed |

## Redis (cross-instance realtime)
Set `REDIS_URL` and the Socket.IO Redis adapter + shared rate limits switch on automatically (no code change).
Tested with a real Redis: an order update triggered on instance B reaches a customer connected to instance A,
and "X viewing" counts are global. Without `REDIS_URL` the same test shows the update being missed - so set it before real customers use live tracking.

## Easypaisa - read this before enabling it
Easypaisa's real callback/signature format could not be verified here. The callback handler is therefore strict:
it accepts a payment only if the POST carries a hash (`merchantHashedResp`, `merchantHashedReq` or `hash`) equal to
`HMAC-SHA256(EASYPAISA_HASH_KEY)` over the other fields (same algorithm as the request signature, `utils/secureHash.js`),
and the order reference, amount and `SUCCESS`/`0000` status match. If Easypaisa's real callback is signed differently,
payments stay "pending" (the customer sees "Confirming your payment") and an admin marks them paid by hand -
they are never auto-approved on trust. When you get the merchant docs (or their transaction-inquiry API), change ONLY
`verifyEasypaisaCallback` in `backend/utils/gatewayVerify.js`. Same caveat applies to JazzCash: field names follow their public guide but were tested only against our own signatures, not their live sandbox.

## Tests
```bash
cd backend
npm install
npm test                                   # 77 tests: pricing, privacy, payments, currency, refunds, races, uploads, headers, CORS, rate limits
TEST_REDIS_URL=redis://127.0.0.1:6379 npm run test:redis   # needs a running Redis (5 tests: cross-instance realtime, tracking over sockets, shared rate limits)
```
The tests run the REAL routes against in-memory stand-ins for the Mongoose models (no database needed),
so they prove the logic, not MongoDB transactions themselves.

## Known limits after Phase 2
- MongoDB transactions need an Atlas replica set (Atlas has one by default).
- WebSockets on Vercel are Beta; verify on a Preview deployment: place a COD order, open `order-confirmation.html`, change its status from the admin panel, watch the badge change.
- Hobby cron runs once a day (see above).
- Guest order tokens live in the browser's localStorage; a guest who clears site data or switches device can no longer open that order page (the confirmation email still exists). Signed-in customers are unaffected.
- Not done (out of scope): refresh-token rotation/revocation lists, CAPTCHA on forms, a Content-Security-Policy for the static pages (needs an audit of the inline scripts and the Stripe/Google/Facebook/Cloudinary hosts).

---

# Phase 2.1 - finalization

## Guest email tracking ("Track your order" from another device)
- Every order email (placed, paid, status, cancelled) links to `order-confirmation.html?orderId=<id>#track=<token>`.
- The token is `orderId.expiry.HMAC-SHA256` signed with `ORDER_TRACKING_SECRET`: bound to that one order, expires after 180 days, can't be forged or re-pointed, nothing is stored in MongoDB, nothing is logged.
- It lives in the URL **fragment** (never sent to the server or in `Referer`). The page reads it, keeps it **in memory only**, sends it as the `X-Order-Tracking-Token` header, and immediately removes it from the address bar (`history.replaceState`). It is never written to localStorage/sessionStorage.
- It is **read-only**: it can view the order and follow live status (REST + Socket.IO), but it can NOT start/confirm a payment or cancel. The checkout browser's `X-Order-Token`, the signed-in owner and admins work exactly as before.
- Anyone with the *email* can use the link until it expires (it is a bearer link). The order id alone reveals nothing.
- Without `ORDER_TRACKING_SECRET` in production, emails simply contain no token (the page then shows the order only to the owner / checkout browser).

## Currency policy
- Canonical currency: **USD** for every price, total, coupon and shipping cost (`order.currency`). Stripe charges USD, no conversion. Cash-on-delivery is collected in the order currency (USD).
- JazzCash/Easypaisa charge **PKR**. A USD number is never sent as PKR. They are offered only when their credentials AND `USD_TO_PKR_RATE` are set; otherwise `initiate` answers 503 "This payment method is not configured for this currency yet" and the checkout disables them.
- When a PKR payment starts, the exact amount, currency and rate are frozen on the order (`gatewayPayment`); the gateway callback must match that snapshot (amount AND currency), even if you change the rate later.
- The customer sees `PKR x (order total USD y, 1 USD = r PKR)` on checkout and in a confirmation dialog **before** being redirected.

## Cancellation and refunds
- **Customer self-cancel:** only `pending` (unpaid) orders - nothing was charged, so nothing is owed. A paid order shows "contact support" and is refused by the server.
- **Admin status menu:** an online-paid order can no longer be flipped to `cancelled` (that would restock goods with no refund). Cash-on-delivery orders still can.
- **Admin "Refund & cancel"** (`POST /api/orders/admin/:id/refund`):
  - *Stripe:* creates a real refund (idempotency key `shopinza-refund-<orderId>`), and only after Stripe accepts it cancels the order, restocks and returns the coupon - exactly once, even with duplicate or concurrent clicks. If Stripe errors or reports `failed`, the order stays `paid`, stock is untouched, `refundStatus = failed`, and it can be retried.
  - *JazzCash/Easypaisa:* automated refunds are **not implemented**. Without a reference the order is only flagged `manual_required` and stays `paid`. After you refund the customer in the provider's portal, run it again with the refund reference: the order is then cancelled/restocked and recorded as `manual_done`.
  - *Late payment on an already-cancelled order:* flagged `paymentIssue`; the same refund action returns the money without restocking again.
- **Emails state only what happened:** "we've refunded" only after a recorded refund, "started a refund" while Stripe is still processing, "no payment had been received" for unpaid cancellations, "contact support" when money was taken but no refund is recorded.
- A Stripe refund created in the Stripe dashboard (outside this admin button) is not synced back automatically (no `charge.refunded` handling yet).

## Late payments
JazzCash/Easypaisa callbacks that arrive after the order was cancelled redirect with `status=late` and the page says: "Payment was received after this order was cancelled. Do not pay again - support will reconcile and refund it." The order stays cancelled and is flagged for refund.

## Uploads
Legacy multipart endpoints have separate limits again: single image (1), gallery (6), review (4), 4 MB per file, and the **whole request** capped at 4.25 MB (under Vercel's ~4.5 MB body limit; bigger requests get a 413 before being buffered). The direct Cloudinary flow remains the preferred path.
