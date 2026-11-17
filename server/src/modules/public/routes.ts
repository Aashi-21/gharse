import type { FastifyInstance } from 'fastify';
import { PUBLIC_PRODUCT_FILTER } from '../products/visibility';
import { toPublicProduct, toPublicStore } from './dto';
import { findPublicStore, isSlug, notFound } from './store';

/**
 * Customer-facing read API. No authentication. Every route answers with the SAME generic 404 whether the store
 * does not exist, is not published, has no approved brand, or the product is not live, so nothing can be enumerated.
 * Product queries always spread PUBLIC_PRODUCT_FILTER (only PUBLISHED products are ever visible).
 */
export async function publicRoutes(app: FastifyInstance) {
  // Stock and visibility change often: never let a browser or proxy serve a stale store page.
  app.addHook('onSend', async (req, reply) => {
    if (!reply.hasHeader('cache-control')) reply.header('Cache-Control', 'no-store');
  });

  const loadStore = (slug: string) => findPublicStore(app.prisma, slug);

  async function loadProduct(storeId: string, productSlug: string) {
    if (!isSlug(productSlug, 80)) throw notFound();
    const product = await app.prisma.product.findFirst({
      where: { storeId, slug: productSlug, ...PUBLIC_PRODUCT_FILTER },
      include: { images: true },
    });
    if (!product) throw notFound();
    return product;
  }

  app.get<{ Params: { slug: string } }>('/api/public/stores/:slug', async (req) => {
    const store = await loadStore(req.params.slug);
    const products = await app.prisma.product.findMany({
      where: { storeId: store.id, ...PUBLIC_PRODUCT_FILTER },
      include: { images: true },
      orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
    });
    return { store: toPublicStore(store), products: products.map((p) => toPublicProduct(store.slug, p)) };
  });

  app.get<{ Params: { slug: string; productSlug: string } }>('/api/public/stores/:slug/products/:productSlug', async (req) => {
    const store = await loadStore(req.params.slug);
    const product = await loadProduct(store.id, req.params.productSlug);
    return { store: toPublicStore(store), product: toPublicProduct(store.slug, product) };
  });

  // Same visibility rules as the page. Any problem with the file itself is also just a 404 (no paths, no details).
  app.get<{ Params: { slug: string; productSlug: string } }>('/api/public/stores/:slug/products/:productSlug/image', async (req, reply) => {
    const store = await loadStore(req.params.slug);
    const product = await loadProduct(store.id, req.params.productSlug);
    const image = [...product.images].sort((a, b) => a.position - b.position)[0];
    if (!image) throw notFound();
    let data: Buffer;
    try {
      data = await app.storage.get(image.storageKey);
    } catch {
      app.log.warn({ productId: product.id }, 'public product image missing or unreadable in storage');
      throw notFound();
    }
    // Short public cache: images are immutable per product, but a product can be unpublished at any time.
    return reply.header('Content-Type', image.mimeType).header('Cache-Control', 'public, max-age=300').send(data);
  });
}
