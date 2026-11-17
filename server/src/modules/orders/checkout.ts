import { createHash } from 'node:crypto';
import { Prisma, type Order, type OrderItem, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { Config } from '../../config';
import { HttpError } from '../../lib/httpError';
import { INDIAN_STATES, indianPhone, indianPincode } from '../../lib/indiaAddress';
import { MAX_ORDER_QUANTITY } from '../public/dto';
import { findPublicStore, isSlug, notFound } from '../public/store';
import { PUBLIC_PRODUCT_FILTER } from '../products/visibility';

export const PAYMENT_NOTE =
  'Payment is arranged directly between you and the seller (for example cash on delivery). GharSe does not collect any payment, and none has been taken.';

/** Postgres INTEGER ceiling. Prices are capped far below this, but price x quantity must still fit. */
const MAX_INT = 2_147_483_647;

const optionalText = (max: number, msg: string) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(max, msg).optional());

/**
 * The ONLY things a customer may send. Strict objects reject anything else, so a request that tries to supply a
 * price, total, delivery charge or status is refused outright: every amount is computed on the server.
 */
export const checkoutSchema = z.strictObject({
  productSlug: z.string().trim().min(1).max(80),
  quantity: z
    .number({ error: 'Enter a quantity' })
    .int('Enter a whole number')
    .min(1, 'Order at least 1')
    .max(MAX_ORDER_QUANTITY, `You can order up to ${MAX_ORDER_QUANTITY} at a time`),
  customer: z.strictObject({
    name: z.string().trim().min(2, 'Enter your name').max(80, 'Keep your name under 80 characters'),
    phone: indianPhone,
  }),
  address: z.strictObject({
    line1: z.string().trim().min(3, 'Enter your address').max(120, 'Keep this under 120 characters'),
    line2: optionalText(120, 'Keep this under 120 characters'),
    city: z.string().trim().min(2, 'Enter your city').max(60, 'Keep this under 60 characters'),
    state: z.enum(INDIAN_STATES, { error: 'Choose your state' }),
    pincode: indianPincode,
  }),
  note: optionalText(300, 'Keep the note under 300 characters'),
  // Honeypot: real people never see or fill this field; bots often do.
  website: z.string().max(0, 'Invalid request').optional(),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const idempotencyKeySchema = z
  .string({ error: 'An Idempotency-Key header is required' })
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'The Idempotency-Key must be 8 to 64 letters, numbers, - or _');

/** What the customer gets back. Deliberately contains NO customer details (name, phone, address or note). */
export function toConfirmation(order: Order & { items: OrderItem[] }) {
  return {
    number: order.orderNumber,
    status: order.status,
    items: order.items.map((i) => ({ title: i.titleSnapshot, unitPricePaise: i.unitPricePaise, quantity: i.quantity })),
    subtotalPaise: order.subtotalPaise,
    deliveryPaise: order.deliveryPaise,
    totalPaise: order.totalPaise,
    paymentNote: PAYMENT_NOTE,
  };
}

/** Stable fingerprint of what the customer asked for, to detect a key being reused for a different request. */
export function requestHash(i: CheckoutInput): string {
  return createHash('sha256')
    .update(JSON.stringify([i.productSlug, i.quantity, i.customer.name, i.customer.phone, i.address.line1, i.address.line2 ?? '', i.address.city, i.address.state, i.address.pincode, i.note ?? '']))
    .digest('hex');
}

type FullOrder = Order & { items: OrderItem[] };

function replayOrConflict(existing: FullOrder, hash: string) {
  if (existing.requestHash !== hash) {
    throw new HttpError(409, 'idempotency_conflict', 'This request key was already used for a different order. Please refresh the page and try again.');
  }
  return { order: existing, replayed: true as const };
}

/**
 * Places ONE order for ONE product (single-product checkout, no payment taken).
 *
 * Guarantees:
 *  - Retries, double-clicks and concurrent identical requests (same Idempotency-Key) create exactly one order and
 *    take stock exactly once. Concurrent identical requests are serialised with a per-key advisory lock; the
 *    unique (storeId, idempotencyKey) index is the backstop.
 *  - Stock is taken with one atomic conditional UPDATE, so N concurrent buyers of the last unit produce exactly
 *    one order. Everything happens in one transaction: any failure leaves stock, counters and orders untouched.
 *  - The price, delivery charge and total come only from the database.
 */
export async function placeOrder(
  prisma: PrismaClient,
  config: Pick<Config, 'ORDER_PHONE_HOURLY_LIMIT' | 'ORDER_STORE_HOURLY_LIMIT'>,
  slug: string,
  key: string,
  input: CheckoutInput,
): Promise<{ order: FullOrder; replayed: boolean }> {
  const store = await findPublicStore(prisma, slug);
  if (store.isSample) {
    throw new HttpError(403, 'demo_store', 'This is a demo store, so orders cannot be placed here.');
  }
  if (!isSlug(input.productSlug, 80)) throw notFound();
  const hash = requestHash(input);
  const byKey = { storeId_idempotencyKey: { storeId: store.id, idempotencyKey: key } };

  // 1. A retry of an order that already succeeded must return that order, never be blocked by limits or stock.
  const earlier = await prisma.order.findUnique({ where: byKey, include: { items: true } });
  if (earlier) return replayOrConflict(earlier, hash);

  // 2. Abuse limits (the per-IP limit is applied by the route before this runs).
  const since = new Date(Date.now() - 3_600_000);
  const [fromPhone, fromStore] = await Promise.all([
    prisma.order.count({ where: { storeId: store.id, customerPhone: input.customer.phone, createdAt: { gte: since } } }),
    prisma.order.count({ where: { storeId: store.id, createdAt: { gte: since } } }),
  ]);
  if (fromPhone >= config.ORDER_PHONE_HOURLY_LIMIT) {
    throw new HttpError(429, 'rate_limited', 'Too many orders from this phone number. Please try again later or contact the seller.');
  }
  if (fromStore >= config.ORDER_STORE_HOURLY_LIMIT) {
    throw new HttpError(429, 'store_busy', 'This store is receiving a lot of orders right now. Please try again in a little while.');
  }

  // 3. The order itself.
  try {
    return await prisma.$transaction(async (tx) => {
      // Serialise concurrent requests that share a key, then re-check: the second one sees the first's order.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${store.id}:${key}`}, 0))::text AS locked`;
      const again = await tx.order.findUnique({ where: byKey, include: { items: true } });
      if (again) return replayOrConflict(again, hash);

      // Atomic conditional stock decrement. Only a live product with enough stock matches; the price and title
      // returned are the ones in force at this exact moment.
      const taken = await tx.$queryRaw<{ id: string; title: string; pricePaise: number }[]>`
        UPDATE products SET stock = stock - ${input.quantity}
        WHERE "storeId" = ${store.id} AND slug = ${input.productSlug} AND status = 'PUBLISHED'
          AND "pricePaise" IS NOT NULL AND stock >= ${input.quantity}
        RETURNING id, title, "pricePaise"`;
      if (taken.length === 0) {
        const product = await tx.product.findFirst({ where: { storeId: store.id, slug: input.productSlug, ...PUBLIC_PRODUCT_FILTER } });
        if (!product) throw new HttpError(409, 'product_unavailable', 'Sorry, this product is no longer available.');
        const available = Math.max(0, Math.min(product.stock, MAX_ORDER_QUANTITY));
        throw new HttpError(
          409,
          'out_of_stock',
          available === 0 ? 'Sorry, this product has just sold out.' : `Only ${available} left. Please lower the quantity.`,
          { quantity: available === 0 ? 'Sold out' : `Only ${available} left` },
        );
      }
      const product = taken[0];

      // Next order number (atomic) and the delivery charge in force right now.
      const counter = await tx.$queryRaw<{ n: number; delivery: number; live: boolean; sample: boolean }[]>`
        UPDATE stores SET "nextOrderNumber" = "nextOrderNumber" + 1 WHERE id = ${store.id}
        RETURNING "nextOrderNumber" - 1 AS n, "deliveryChargePaise" AS delivery, "isPublished" AS live, "isSample" AS sample`;
      if (counter.length === 0 || !counter[0].live || counter[0].sample) {
        throw new HttpError(409, 'store_unavailable', 'This store is not accepting orders right now.');
      }

      const subtotal = product.pricePaise * input.quantity;
      const delivery = counter[0].delivery;
      const total = subtotal + delivery;
      if (total > MAX_INT) throw new HttpError(400, 'validation_error', 'This order is too large. Please lower the quantity.', { quantity: 'Order total is too large' });

      const order = await tx.order.create({
        data: {
          storeId: store.id,
          orderNumber: counter[0].n,
          customerName: input.customer.name,
          customerPhone: input.customer.phone,
          shippingLine1: input.address.line1,
          shippingLine2: input.address.line2 ?? null,
          shippingCity: input.address.city,
          shippingState: input.address.state,
          shippingPincode: input.address.pincode,
          note: input.note ?? null,
          subtotalPaise: subtotal,
          deliveryPaise: delivery,
          totalPaise: total,
          idempotencyKey: key,
          requestHash: hash,
          items: { create: { productId: product.id, titleSnapshot: product.title, unitPricePaise: product.pricePaise, quantity: input.quantity } },
        },
        include: { items: true },
      });
      return { order, replayed: false };
    });
  } catch (err) {
    // Backstop: if the unique index (not the lock) caught a duplicate, return the winner instead of failing.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const winner = await prisma.order.findUnique({ where: byKey, include: { items: true } });
      if (winner) return replayOrConflict(winner, hash);
    }
    throw err;
  }
}
