const { toCents, fromCents } = require('./money');

const MAX_LINES = 50; // distinct lines in one order
const MAX_QTY_PER_LINE = 20; // units of one product/variant per order

/** Error the route turns into a clean 400/409 for the customer. */
class OrderInputError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.name = 'OrderInputError';
        this.status = status;
    }
}

function isPlainString(value, max = 200) {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * Step 1 - validates the raw cart the client sent and merges duplicate lines.
 * Only { productId (slug), qty, color, size } are read from the client; price,
 * name and image are NEVER taken from it (see priceItems below).
 */
function normalizeRequestedItems(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
        throw new OrderInputError('Your cart is empty.');
    }
    if (rawItems.length > MAX_LINES) {
        throw new OrderInputError(`You can order at most ${MAX_LINES} different items at once.`);
    }

    const merged = new Map();

    for (const raw of rawItems) {
        if (!raw || typeof raw !== 'object') throw new OrderInputError('Your cart contains an invalid item.');

        const { productId, qty, color, size } = raw;

        if (!isPlainString(productId, 200)) throw new OrderInputError('Your cart contains an invalid item.');

        // qty must be a whole number >= 1. A negative or fractional qty would
        // otherwise turn the stock decrement into an INCREMENT.
        if (!Number.isInteger(qty) || qty < 1) {
            throw new OrderInputError('Item quantities must be whole numbers of at least 1.');
        }
        if (color !== undefined && color !== null && color !== '' && !isPlainString(color, 60)) {
            throw new OrderInputError('Your cart contains an invalid item.');
        }
        if (size !== undefined && size !== null && size !== '' && !isPlainString(size, 60)) {
            throw new OrderInputError('Your cart contains an invalid item.');
        }

        const key = `${productId}\u0000${color || ''}\u0000${size || ''}`;
        const existing = merged.get(key);
        if (existing) existing.qty += qty;
        else merged.set(key, { productId, qty, color: color || undefined, size: size || undefined });
    }

    const lines = [...merged.values()];
    for (const line of lines) {
        if (line.qty > MAX_QTY_PER_LINE) {
            throw new OrderInputError(`You can order at most ${MAX_QTY_PER_LINE} units of the same item.`);
        }
    }
    return lines;
}

/**
 * Step 2 - builds the order lines from the DATABASE's product data.
 * `productsBySlug` is a Map/plain object of slug -> product document (or a
 * lean object with name, price, image, variants).
 */
function priceItems(requestedLines, productsBySlug) {
    const get = (slug) => (productsBySlug instanceof Map ? productsBySlug.get(slug) : productsBySlug[slug]);

    let subtotalCents = 0;
    const items = [];

    for (const line of requestedLines) {
        const product = get(line.productId);
        if (!product) throw new OrderInputError('An item in your cart is no longer available.', 409);

        const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;
        let color;
        let size;

        if (hasVariants) {
            const variant = product.variants.find((v) => v.color === line.color && v.size === line.size);
            if (!line.color || !line.size || !variant) {
                throw new OrderInputError(`Please choose a valid colour and size for "${product.name}".`, 409);
            }
            color = line.color;
            size = line.size;
        }
        // products WITHOUT variants ignore any colour/size the client sent

        const priceCents = toCents(product.price);
        if (!Number.isFinite(priceCents) || priceCents < 0) {
            throw new OrderInputError(`"${product.name}" cannot be ordered right now.`, 409);
        }

        subtotalCents += priceCents * line.qty;
        items.push({
            productId: product.slug || line.productId,
            name: product.name,
            price: fromCents(priceCents),
            image: product.image,
            qty: line.qty,
            color,
            size,
        });
    }

    return { items, subtotalCents };
}

/** Step 3 - totals. Discount is capped so an order can never go negative. */
function computeTotals({ subtotalCents, shippingCents, discountCents = 0 }) {
    const discount = Math.min(Math.max(discountCents, 0), subtotalCents);
    const totalCents = Math.max(subtotalCents + shippingCents - discount, 0);
    return {
        subtotal: fromCents(subtotalCents),
        shippingCost: fromCents(shippingCents),
        discount: fromCents(discount),
        total: fromCents(totalCents),
        totalCents,
    };
}

module.exports = { OrderInputError, normalizeRequestedItems, priceItems, computeTotals, MAX_QTY_PER_LINE, MAX_LINES };
