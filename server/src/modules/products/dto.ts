import type { Product, ProductImage } from '@prisma/client';

type ProductWithImages = Product & { images: ProductImage[] };

/** Shape sent to the seller's browser. Never exposes storage keys or the raw AI audit blob. */
export function toProductDto(p: ProductWithImages) {
  const image = [...p.images].sort((a, b) => a.position - b.position)[0];
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    category: p.category,
    tags: p.tags,
    pricePaise: p.pricePaise,
    stock: p.stock,
    status: p.status,
    sellerNotes: (p.sellerNotes as { text?: string } | null)?.text ?? '',
    openQuestions: (p.openQuestions as { attribute: string; question: string }[] | null) ?? [],
    visibleCharacteristics: p.visibleCharacteristics,
    brandVersion: p.brandVersion,
    imageUrl: image ? `/api/seller/products/${p.id}/image` : null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
