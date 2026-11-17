import type { Product, ProductImage } from '@prisma/client';
import { getPublishIssues } from './publishing';
import { readSellerFacts } from './sellerFacts';

type ProductWithImages = Product & { images: ProductImage[] };

/** Shape sent to the seller's browser. Never exposes storage keys or the raw AI audit blob. */
export function toProductDto(p: ProductWithImages) {
  const image = [...p.images].sort((a, b) => a.position - b.position)[0];
  const facts = readSellerFacts(p.sellerNotes);
  const issues = getPublishIssues(p, p.images.length, { live: p.status === 'PUBLISHED' });
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    category: p.category,
    tags: p.tags,
    pricePaise: p.pricePaise,
    stock: p.stock,
    status: p.status,
    sellerNotes: facts.text,
    answers: Object.entries(facts.answers).map(([attribute, a]) => ({ attribute, question: a.question, answer: a.answer })),
    openQuestions: (p.openQuestions as { attribute: string; question: string }[] | null) ?? [],
    visibleCharacteristics: p.visibleCharacteristics,
    brandVersion: p.brandVersion,
    publishedAt: p.publishedAt,
    /** What is still missing before this can be (or stay) live. Computed by the backend; the UI only displays it. */
    readiness: { canPublish: issues.length === 0, issues },
    imageUrl: image ? `/api/seller/products/${p.id}/image` : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
