/** Fixed list so Claude's category, the edit dropdown and server validation always agree. */
export const PRODUCT_CATEGORIES = [
  'Candles & Home Fragrance',
  'Crochet & Knitting',
  'Jewellery',
  'Home Décor',
  'Diyas & Festive',
  'Resin Art',
  'Bags & Accessories',
  'Gifts & Hampers',
  'Art & Paintings',
  'Other',
] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];
