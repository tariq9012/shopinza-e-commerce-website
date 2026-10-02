/* ==========================================================
   Shopinza - socket.js
   One shared Socket.io connection per page, plus small helpers
   for the two real-time features:
     - live order status updates (My Orders, order confirmation)
     - "X people viewing this product" (product details)
   Depends on config.js (SOCKET_URL, OrderAccess, Api) and the Socket.io
   client script (loaded via CDN) being included BEFORE this file.

   Rooms are remembered and RE-JOINED after every (re)connect: Vercel closes
   long-lived WebSockets after a while and Socket.IO reconnects on its own, but
   a fresh connection has no rooms - without re-joining, live updates would
   silently stop.
   ========================================================== */

const AppSocket = {
    _socket: null,
    _orders: new Set(),
    _products: new Set(),

    /** Lazily creates the connection - only pages that actually use realtime features pay for it. */
    get() {
        if (!this._socket) {
            if (typeof io === 'undefined') {
                console.warn('Socket.io client script did not load - realtime features are disabled on this page.');
                return null;
            }
            // WebSocket ONLY: Vercel's docs require the WebSocket transport for
            // Socket.IO (its default HTTP long-polling sends each request to a
            // possibly different instance, which breaks the handshake).
            this._socket = io(SOCKET_URL, { transports: ['websocket'] });

            // fires on the first connect AND on every automatic reconnect
            this._socket.on('connect', () => {
                this._orders.forEach((orderId) => this._emitOrderJoin(orderId));
                this._products.forEach((slug) => this._socket.emit('product:join', slug));
            });
        }
        return this._socket;
    },

    // ---------- Order tracking ----------
    _emitOrderJoin(orderId) {
        // the server only lets the order's owner (login token) or the browser that placed it
        // (order access token) into its room
        this._socket.emit('order:join', {
            orderId,
            jwt: Api.getToken() || undefined,
            orderToken: OrderAccess.get(orderId) || undefined,
            trackingToken: OrderAccess.getTracking(orderId) || undefined, // from an emailed link (memory only)
        });
    },

    joinOrder(orderId) {
        const socket = this.get();
        if (!socket || !orderId) return;
        this._orders.add(orderId);
        if (socket.connected) this._emitOrderJoin(orderId); // otherwise the 'connect' handler joins it
    },

    leaveOrder(orderId) {
        const socket = this.get();
        if (!socket || !orderId) return;
        this._orders.delete(orderId);
        socket.emit('order:leave', orderId);
    },

    /** callback receives { orderId, status } whenever ANY joined order changes - filter by orderId yourself. */
    onOrderUpdate(callback) {
        const socket = this.get();
        if (socket) socket.on('order:updated', callback);
    },

    // ---------- "X people viewing this product" ----------
    joinProduct(slug) {
        const socket = this.get();
        if (!socket || !slug) return;
        this._products.add(slug);
        if (socket.connected) socket.emit('product:join', slug);
    },

    leaveProduct(slug) {
        const socket = this.get();
        if (!socket || !slug) return;
        this._products.delete(slug);
        socket.emit('product:leave', slug);
    },

    /** callback receives { slug, count }. */
    onProductViewers(callback) {
        const socket = this.get();
        if (socket) socket.on('product:viewers', callback);
    },
};
