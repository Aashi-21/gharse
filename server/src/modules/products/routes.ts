import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/httpError';
import { getSellerStore } from '../../lib/ownership';
import { slugify } from '../../lib/slug';
import { enforceAiQuota } from '../ai/client';
import { generateListing } from '../ai/listingService';
import { getApprovedBrand } from '../brand/service';
import { PRODUCT_CATEGORIES } from './categories';
import { toProductDto } from './dto';
import { readProductUpload } from './upload';

const MAX_PRICE_PAISE = 10_000_000 * 100; // ₹1 crore

/** Rupees as typed by the seller ("499", "499.5", 499) -> integer paise. Empty -> null. */
const rupeesToPaise = z
  .union([z.string(), z.number(), z.null()])
  .transform((v, ctx) => {
    if (v === null || (typeof v === 'string' && v.trim() === '')) return null;
    const s = String(v).trim().replace(/^₹\s*/, '');
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) {
      ctx.addIssue({ code: 'custom', message: 'Enter a price in rupees, like 499 or 499.50' });
      return z.NEVER;
    }
    const paise = Math.round(Number(s) * 100);
    if (paise <= 0 || paise > MAX_PRICE_PAISE) {
      ctx.addIssue({ code: 'custom', message: 'Enter a price greater than ₹0' });
      return z.NEVER;
    }
    return paise;
  });

const tagsSchema = z
  .array(z.string().trim().toLowerCase().min(1).max(30, 'Tags must be under 30 characters'))
  .max(10, 'Use at most 10 tags')
  .transform((t) => [...new Set(t)]);

// Only these fields are editable by the seller. status/brandVersion/aiDraft can never be set from the client.
const patchBody = z.object({
  title: z.string().trim().min(2, 'Enter a title').max(120, 'Keep the title under 120 characters').optional(),
  description: z.string().trim().max(3000, 'Keep the description under 3000 characters').optional(),
  category: z.enum(PRODUCT_CATEGORIES, { error: 'Choose a category from the list' }).nullable().optional(),
  tags: tagsSchema.optional(),
  price: rupeesToPaise.optional(),
  stock: z.number({ error: 'Enter a whole number' }).int('Enter a whole number').min(0, 'Stock cannot be negative').max(100000).optional(),
});

/** Every query below starts from the logged-in seller's store, so a product id from another seller is simply "not found". */
export async function productRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  async function ownedProduct(userId: string, id: string) {
    const store = await getSellerStore(app.prisma, userId);
    const product = await app.prisma.product.findFirst({ where: { id, storeId: store.id }, include: { images: true } });
    if (!product) throw new HttpError(404, 'not_found', 'Product not found.');
    return product;
  }

  app.get('/api/seller/products', async (req) => {
    const store = await getSellerStore(app.prisma, req.user!.id);
    const products = await app.prisma.product.findMany({
      where: { storeId: store.id },
      include: { images: true },
      orderBy: { createdAt: 'desc' },
    });
    return { products: products.map(toProductDto) };
  });

  // Photo -> brand-consistent DRAFT listing. Nothing is published; price and stock are left for the seller.
  app.post('/api/seller/products/analyze', async (req, reply) => {
    const store = await getSellerStore(app.prisma, req.user!.id);
    // Brand memory: read the approved brand from PostgreSQL on every request. 409 if there isn't one.
    const brand = await getApprovedBrand(app.prisma, store.id);

    const { image, info, notes } = await readProductUpload(req); // validates bytes before any AI spend
    await enforceAiQuota(app.prisma, app.config, store.id);

    const startedAt = new Date();
    const listing = await generateListing(app.ai, {
      model: app.config.CLAUDE_MODEL_SMART,
      storeId: store.id,
      brand,
      image: { base64: image.toString('base64'), mime: info.mime },
      notes,
    });

    // Only now touch storage and the DB, so a failed Claude call leaves nothing behind.
    const storageKey = `products/${store.id}/${randomUUID()}.${info.ext}`;
    await app.storage.put(storageKey, image);
    let product;
    try {
      product = await app.prisma.product.create({
        data: {
          storeId: store.id,
          slug: `${slugify(listing.title)}-${randomBytes(3).toString('hex')}`,
          title: listing.title,
          description: listing.description,
          category: listing.category,
          tags: [...new Set(listing.tags.map((t) => t.toLowerCase()))].slice(0, 10),
          visibleCharacteristics: listing.visibleCharacteristics,
          openQuestions: listing.openQuestions,
          aiDraft: listing,
          brandVersion: brand.version,
          sellerNotes: notes ? { text: notes } : undefined,
          status: 'DRAFT',
          images: { create: { storageKey, mimeType: info.mime, sizeBytes: image.length } },
        },
        include: { images: true },
      });
    } catch (err) {
      await app.storage.delete(storageKey);
      throw err;
    }
    // Link this request's audit rows (all attempts) to the new product.
    await app.prisma.aiGeneration.updateMany({
      where: { storeId: store.id, kind: 'LISTING', productId: null, createdAt: { gte: startedAt } },
      data: { productId: product.id },
    });
    return reply.code(201).send({ product: toProductDto(product) });
  });

  app.get<{ Params: { id: string } }>('/api/seller/products/:id', async (req) => {
    const product = await ownedProduct(req.user!.id, req.params.id);
    return { product: toProductDto(product) };
  });

  app.patch<{ Params: { id: string } }>('/api/seller/products/:id', async (req) => {
    const b = patchBody.parse(req.body);
    const existing = await ownedProduct(req.user!.id, req.params.id);
    const product = await app.prisma.product.update({
      where: { id: existing.id },
      data: {
        ...(b.title !== undefined && { title: b.title }),
        ...(b.description !== undefined && { description: b.description }),
        ...(b.category !== undefined && { category: b.category }),
        ...(b.tags !== undefined && { tags: b.tags }),
        ...(b.price !== undefined && { pricePaise: b.price }),
        ...(b.stock !== undefined && { stock: b.stock }),
      },
      include: { images: true },
    });
    return { product: toProductDto(product) };
  });

  // Seller-only image access. (A public storefront image route comes with the storefront phase.)
  app.get<{ Params: { id: string } }>('/api/seller/products/:id/image', async (req, reply) => {
    const product = await ownedProduct(req.user!.id, req.params.id);
    const image = [...product.images].sort((a, b) => a.position - b.position)[0];
    if (!image) throw new HttpError(404, 'not_found', 'This product has no image.');
    let data: Buffer;
    try {
      data = await app.storage.get(image.storageKey);
    } catch {
      throw new HttpError(404, 'not_found', 'Image file not found.');
    }
    return reply.header('Content-Type', image.mimeType).header('Cache-Control', 'private, max-age=3600').send(data);
  });
}
