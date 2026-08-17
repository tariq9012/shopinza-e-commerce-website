/**
 * Populates the products collection with the same demo products that are
 * currently hardcoded in index.html / shop.html / product-details.html.
 *
 * Run with: npm run seed
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Product = require('../models/Product');

const products = [
    {
        slug: 'minimalist-ceramic-vase',
        name: 'Minimalist Ceramic Vase',
        description: 'A hand-finished ceramic vase with clean lines, perfect for a minimalist shelf or table setting.',
        category: 'Home Decor',
        price: 120.0,
        image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDJQHg4UBLnSHXfiEFFM7XL4AFxukExjfxTGuSilxjDt6zm8z5YUErgxtubn-aBgjFkoSBWgK-ZvE_S0lTJYUrhCXPp0I8B3XZKGHD4acAHfTe-27m3Ir56_36Ys22m6RXGaVvO68GyDbtSv04UsuOzT_20VOsnYvWnboDTH46u3rFrXGoS1TEYmQrmki9vdXas5tw4WpqcgY4zQlv8roCzp8T8VEzgpiCkNDXahgcxJT6ZEXu78jRjGg',
        rating: 4.8,
        reviewCount: 32,
    },
    {
        slug: 'classic-leather-wallet',
        name: 'Classic Leather Wallet',
        description: 'Full-grain leather wallet with six card slots and a slim profile that fits any pocket.',
        category: 'Accessories',
        price: 85.0,
        image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDpOV1_pjdzFnzUtjruaiL_kpavNE48-Kr6xpc3bqfy7JB7RRqC0X6chkZIyPBWrxAFQA4tSsgQI_n_Hk3ABF56xlPCDaklekPlx23Mm4n4-c9yqZubbHXxUVmuw3xYFKybJNnA_fupnL7uCHzSUTJN-AxFSxSoXPaBGtJPdLAEZPRxU9QjSBv5EkfBvj6x8C5ou4mdTSLL2vsTN_SP3t9mTW_hN0BjhBPRuxuiZN8pL2UlxSZHMqkhQg',
        rating: 5.0,
        reviewCount: 18,
    },
    {
        slug: 'hydrating-glow-serum',
        name: 'Hydrating Glow Serum',
        description: 'A lightweight daily serum formulated to hydrate and brighten skin over time.',
        category: 'Apparel',
        price: 65.0,
        image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDahFvJkLJCipg_K0BltQqGm3vpv-epkihKjvrAEMQaQq7pj3pmPyb6ZgcyNCznm9laTvek67xS7Rc_JYk-Hr3I0JE3hvS9HKOqX2j_4V1Z_5HIrzoXezfRdkaeK0LlgCTKv7BZfkTM2VIT1tQ_OwmTQXTquZMy9-xdBOYVXzjeVZ7cCdpMBYGD5qkD1ibLvhRjtQlPFQ1btVrbKzKXjwakIg0N6ARz332CyCeaB6feUqq-bENfriPCaw',
        rating: 4.2,
        reviewCount: 41,
    },
    {
        slug: 'aura-wireless-headphones',
        name: 'Aura Wireless Headphones',
        description: 'Over-ear wireless headphones with active noise cancellation and 40-hour battery life.',
        category: 'Electronics',
        price: 299.0,
        image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAu3LYtH4xmkcikXropxIM4XDWBeLZQ9H6b94ucLXIYdsVlNhqOSivbuhgxCQ6ILBWit1wEHul1geA0IMB0E_L1B3pDRPTCsYQPLYCDnDHfM6FvEIZ5LfeSZzafK1z0Z3YKupeFBjbvvMEzH-vfRqzh6JHeN3oNL3PlA9vQDGSyqu8kjpg9ylMwikUyXfSddOIBVERojh5fjLAQJV9r0tlA9_EwSDHGtt6DmuVlRplNWe66FtVMXraPjQ',
        rating: 4.7,
        reviewCount: 124,
    },
    {
        slug: 'premium-leather-watch',
        name: 'Premium Leather Watch',
        description: 'A refined chronograph watch with a genuine leather strap and stainless steel case.',
        category: 'Accessories',
        price: 199.99,
        oldPrice: 250.0,
        image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBU0R6Y_7Lbo92ZNyjt7pvUjB8tH5N8IJEfb0rRIA6Et8b6dhklhZ7Ki8-mEhYEWb4g22mLjUs7NwNAJUD7KzPdGv6a27P5q7SWwk-Ig4efgx-N0S1FY5ISEwaTaSlo0iInz-cRtt76EdU8vCWA0kSbil4tJs8IFN7KiB2yodNEUgT0XHemdrvd02mQfBzH5lJBiJ9plGfWzKI8Qa1H97jnox6tn7zy2EYrlUr7FPc5__Me2LJYml6ryw',
        rating: 4.8,
        reviewCount: 56,
    },
    {
        slug: 'minimalist-wireless-headphones',
        name: 'Minimalist Wireless Headphones',
        description: 'Compact on-ear wireless headphones with a clean, understated design.',
        category: 'Electronics',
        price: 149.0,
        image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCQO8cKFhWSPOhwLfR7zUmzkRiP4U0ziNNQMaBPTxxqIFRSfdD69HCHOz9NpXcfoxbxU5TnjH1wMHiXSWo7Opl5_Vasli62mRL9gHyeDz93rpardwsPjeqwOtNm2kMpEFm__wOqZUVcUlfnsi3pLb34YGxyf1jfQyT7Zt-n9HuNNke3Apjou8xT8haqk2x_aQ58tDLL2vCo3aoaV7zY3SwWEaeXXDqg2fHPhVyNil9b2SL1ddAfhInb1g',
        rating: 4.0,
        reviewCount: 29,
    },
    {
        slug: 'modern-ceramic-vase',
        name: 'Modern Ceramic Vase',
        description: 'A sculptural ceramic vase with a modern silhouette, glazed in a soft neutral tone.',
        category: 'Home Decor',
        price: 85.0,
        image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCKxIHnJSEXtHJ2cNk2HNsatTevh-1thT_832aFjSmD5-vKx6b_w0JtH_nx5GnIOOM2fXRl_WW_TvaT6XlbJ0VaUGKfDLY3rzentTxfx96F80MEAc7OOFi6Wx1OzUgEngdIiZ9azHpkixFTfMT2n4lrP7qimpZsde5TXUqXLgtqqPwWPMEQ1x-PjUQUaCMEzwsIUVrqjZatbMjWv6fD1w9yImrtFHE8YVaUF0z-N_-UpgFWz_DHRgHrrg',
        rating: 5.0,
        reviewCount: 21,
    },
    {
        slug: 'signature-noise-cancelling-headphones',
        name: 'Signature Noise-Cancelling Headphones',
        description: 'Studio-quality sound with active noise cancellation, 40-hour battery, and memory-foam comfort.',
        category: 'Electronics',
        price: 299.0,
        oldPrice: 349.0,
        image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBUIA14DFh4_nBFYeraXvBPlaNJgVBhkOEFULNKqEmcD__Ty56_lYT_UQgmRh9GMafR0ciYHoj936qT7guf5xq3ysFy4nIZX0kUHdDB8LrT_jQ69bUSkhxFs9SX5NdV-3zRntG45WnoutYGbMFYLFN0Dmz3Oepmgf-gJgqqRiq2VQSLcOvk5vfTUQfC5mlK3iyxJq_BO3ZdfOsN3wsmdWXA3R5aYTKfGPXeDKFsAd49-SaA1IhkowDtbg',
        images: [
            'https://lh3.googleusercontent.com/aida-public/AB6AXuC8GtFcTjkrloznTuy2uaX51cREavq298derIh4-U7udfWOuGEPdQApraTZqSvRtqZptWo00AyCgfOdxl4O5m98K7KulS8uWhZgqFmbCD9UV0Sz4TXHmu2t6meVltoBipTi98cxc9cdoeXwIuyVNLe20u7MEgnssHD5YDHm9GmIE-zJCQkUtMiwSdH-_UwRHGXxfpDse-o5MVanLn7IukiRQDsjiqrYegWtd2pp91_3o8r3IRv7oS-wZw',
            'https://lh3.googleusercontent.com/aida-public/AB6AXuDcXDvZX6ksAWwLOJYbm3wYlRQwoeXsjndJcB60qTJi5DHq2wB3Xt6jhKZG24iie_Auk5TlbVo8wusUe9egR2ky6rCITCaG3-x48pgLGifVYYdrOgLE6EdAJOTAKcVDiOSvr_49DGyFkKLVEmU4NA2sMn1UKhFN9pr-tSMsv8wrn1a30M1OKw6tI-CwgEL0zgVqAsxdGOFHaU3qUwvdlZe_m_dXWXnBC3AEnBnyYJPOwEUVzhM0-nDf1w',
        ],
        colors: [
            { name: 'Midnight Black', hex: '#111111' },
            { name: 'Silver', hex: '#E5E5E5' },
            { name: 'Navy', hex: '#1B2A47' },
        ],
        rating: 4.8,
        reviewCount: 124,
    },
];

async function seed() {
    await connectDB();

    for (const product of products) {
        await Product.findOneAndUpdate({ slug: product.slug }, product, {
            upsert: true,
            new: true,
        });
    }

    console.log(`Seeded ${products.length} products.`);
    await mongoose.disconnect();
    process.exit(0);
}

seed().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
});
