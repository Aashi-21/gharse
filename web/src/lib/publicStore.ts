export interface PublicStore {
  slug: string;
  name: string;
  tagline: string;
  story: string;
  primaryColor: string;
  secondaryColor: string;
  contactPhone: string | null;
  deliveryPolicy: string | null;
  returnPolicy: string | null;
  deliveryChargePaise: number;
  isSample: boolean;
  checkoutEnabled: boolean;
}

export interface PublicProduct {
  slug: string;
  title: string;
  description: string;
  category: string | null;
  tags: string[];
  pricePaise: number;
  inStock: boolean;
  maxQuantity: number;
  imageUrl: string | null;
}

export const PAYMENT_NOTE =
  'GharSe does not collect any payment. You pay the seller directly (cash on delivery or another way you agree with them).';

export const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
