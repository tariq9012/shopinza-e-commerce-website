/**
 * Money helpers. All arithmetic is done in integer CENTS so 0.1 + 0.2 style
 * floating-point errors can never change what a customer is charged.
 */
function toCents(amount) {
    return Math.round(Number(amount) * 100);
}

function fromCents(cents) {
    return Math.round(cents) / 100;
}

module.exports = { toCents, fromCents };
