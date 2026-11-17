export interface Product {
  id: string;
  title: string;
  description: string;
  category: string | null;
  tags: string[];
  pricePaise: number | null;
  stock: number;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  sellerNotes: string;
  openQuestions: { attribute: string; question: string }[];
  visibleCharacteristics: string[];
  brandVersion: number | null;
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
