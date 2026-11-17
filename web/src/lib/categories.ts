// Keep in sync with server/src/modules/products/categories.ts (the server validates).
export const PRODUCT_CATEGORIES = [
  'Candles & Home Fragrance', 'Crochet & Knitting', 'Jewellery', 'Home Décor', 'Diyas & Festive',
  'Resin Art', 'Bags & Accessories', 'Gifts & Hampers', 'Art & Paintings', 'Other',
] as const;

export const rupees = (paise: number | null) => (paise === null ? '' : (paise / 100).toFixed(2).replace(/\.00$/, ''));
