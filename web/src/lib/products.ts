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
  answers: { attribute: string; question: string; answer: string }[];
  openQuestions: { attribute: string; question: string }[];
  visibleCharacteristics: string[];
  brandVersion: number | null;
  publishedAt: string | null;
  /** Computed by the backend from the saved product. The UI only displays it. */
  readiness: { canPublish: boolean; issues: { field: string; message: string }[] };
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
}
