import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/httpError';
import { indianPhone } from '../../lib/indiaAddress';
import { getSellerStore } from '../../lib/ownership';
import { PUBLIC_PRODUCT_FILTER } from '../products/visibility';

export const MIN_POLICY_LENGTH = 10;
export const MAX_DELIVERY_CHARGE_PAISE = 1_000_000; // ₹10,000

export interface StoreIssue {
  field: 'brand' | 'contactPhone' | 'deliveryPolicy' | 'returnPolicy' | 'products';
  message: string;
}

/**
 * The single, backend-authoritative definition of "this store may be shown to customers".
 * Store publication is independent of product publication: a store needs at least one PUBLISHED product to go live,
 * but publishing a product never publishes the store (and vice versa).
 */
export function getStorePublishIssues(
  s: { contactPhone: string | null; deliveryPolicy: string | null; returnPolicy: string | null },
  hasApprovedBrand: boolean,
  publishedProducts: number,
): StoreIssue[] {
  const issues: StoreIssue[] = [];
  if (!hasApprovedBrand) issues.push({ field: 'brand', message: 'Create and approve your brand first.' });
  if (!s.contactPhone) issues.push({ field: 'contactPhone', message: 'Add the phone number customers can contact you on.' });
  if (!s.deliveryPolicy || s.deliveryPolicy.trim().length < MIN_POLICY_LENGTH) {
    issues.push({ field: 'deliveryPolicy', message: `Describe your delivery policy (at least ${MIN_POLICY_LENGTH} characters).` });
  }
  if (!s.returnPolicy || s.returnPolicy.trim().length < MIN_POLICY_LENGTH) {
    issues.push({ field: 'returnPolicy', message: `Describe your return policy (at least ${MIN_POLICY_LENGTH} characters).` });
  }
  if (publishedProducts < 1) issues.push({ field: 'products', message: 'Publish at least one product.' });
  return issues;
}

const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** Rupees as typed ("0", "60", "60.50", "₹ 60") -> integer paise, 0 allowed (free delivery). */
const deliveryCharge = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const s = String(v).trim().replace(/^₹\s*/, '');
    if (s === '') return 0;
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(s)) {
      ctx.addIssue({ code: 'custom', message: 'Enter the delivery charge in rupees, like 60 or 0 for free delivery' });
      return z.NEVER;
    }
    const paise = Math.round(Number(s) * 100);
    if (paise > MAX_DELIVERY_CHARGE_PAISE) {
      ctx.addIssue({ code: 'custom', message: 'The delivery charge cannot be more than ₹10,000' });
      return z.NEVER;
    }
    return paise;
  });

const policy = z.preprocess(emptyToNull, z.string().trim().max(1000, 'Keep it under 1000 characters').nullable());

// Every field is optional (omitted = unchanged). The contact phone is NEVER copied from the seller's profile:
// it is shown to customers only if the seller types it here.
const settingsBody = z.object({
  contactPhone: z.preprocess(emptyToNull, indianPhone.nullable()).optional(),
  deliveryPolicy: policy.optional(),
  returnPolicy: policy.optional(),
  deliveryCharge: deliveryCharge.optional(),
});

/** Seller-facing store settings and the explicit "make my store public" action. All scoped to the seller's own store. */
export async function storeSettingsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  const view = async (storeId: string) => {
    const [store, brand, publishedProducts] = await Promise.all([
      app.prisma.store.findUniqueOrThrow({ where: { id: storeId } }),
      app.prisma.brandProfile.findFirst({ where: { storeId, status: 'APPROVED' }, select: { id: true } }),
      app.prisma.product.count({ where: { storeId, ...PUBLIC_PRODUCT_FILTER } }),
    ]);
    const issues = getStorePublishIssues(store, !!brand, publishedProducts);
    return {
      slug: store.slug,
      isPublished: store.isPublished,
      isSample: store.isSample,
      settings: {
        contactPhone: store.contactPhone,
        deliveryPolicy: store.deliveryPolicy,
        returnPolicy: store.returnPolicy,
        deliveryChargePaise: store.deliveryChargePaise,
      },
      readiness: { canPublish: issues.length === 0, issues },
    };
  };

  app.get('/api/seller/store/settings', async (req) => {
    const store = await getSellerStore(app.prisma, req.user!.id);
    return view(store.id);
  });

  app.put('/api/seller/store/settings', async (req) => {
    const b = settingsBody.parse(req.body);
    const store = await getSellerStore(app.prisma, req.user!.id);
    await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stores WHERE id = ${store.id} FOR UPDATE`;
      const cur = await tx.store.findUniqueOrThrow({ where: { id: store.id } });
      const next = {
        contactPhone: b.contactPhone !== undefined ? b.contactPhone : cur.contactPhone,
        deliveryPolicy: b.deliveryPolicy !== undefined ? b.deliveryPolicy : cur.deliveryPolicy,
        returnPolicy: b.returnPolicy !== undefined ? b.returnPolicy : cur.returnPolicy,
      };
      // A LIVE store must keep the details customers rely on.
      if (cur.isPublished) {
        const issues = getStorePublishIssues(next, true, 1).filter((i) => i.field !== 'products' && i.field !== 'brand');
        if (issues.length > 0) {
          throw new HttpError(
            400,
            'validation_error',
            'Your store is live, so it must keep its contact phone and policies. Unpublish it first if you want to remove them.',
            Object.fromEntries(issues.map((i) => [i.field, i.message])),
          );
        }
      }
      await tx.store.update({
        where: { id: store.id },
        data: { ...next, ...(b.deliveryCharge !== undefined && { deliveryChargePaise: b.deliveryCharge }) },
      });
    });
    return view(store.id);
  });

  // Make the store public. Validated on the locked row inside one transaction; idempotent.
  app.post('/api/seller/store/publish', async (req) => {
    const store = await getSellerStore(app.prisma, req.user!.id);
    await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stores WHERE id = ${store.id} FOR UPDATE`;
      const cur = await tx.store.findUniqueOrThrow({ where: { id: store.id } });
      if (cur.isPublished) return;
      const [brand, publishedProducts] = await Promise.all([
        tx.brandProfile.findFirst({ where: { storeId: store.id, status: 'APPROVED' }, select: { id: true } }),
        tx.product.count({ where: { storeId: store.id, ...PUBLIC_PRODUCT_FILTER } }),
      ]);
      const issues = getStorePublishIssues(cur, !!brand, publishedProducts);
      if (issues.length > 0) {
        throw new HttpError(400, 'store_not_publishable', 'Your store is not ready to go public yet.', Object.fromEntries(issues.map((i) => [i.field, i.message])));
      }
      await tx.store.update({ where: { id: store.id }, data: { isPublished: true } });
    });
    return view(store.id);
  });

  // Take the store offline. Products and orders are untouched.
  app.post('/api/seller/store/unpublish', async (req) => {
    const store = await getSellerStore(app.prisma, req.user!.id);
    await app.prisma.store.update({ where: { id: store.id }, data: { isPublished: false } });
    return view(store.id);
  });
}
