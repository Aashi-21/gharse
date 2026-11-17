import type { PrismaClient } from '@prisma/client';
import { HttpError } from './httpError';

/**
 * The single place that answers "which store belongs to this logged-in user".
 * Every seller-scoped query must start from the store returned here, never from a client-supplied id alone.
 */
export async function getSellerStore(prisma: PrismaClient, userId: string) {
  const store = await prisma.store.findFirst({ where: { sellerProfile: { userId } } });
  if (!store) throw new HttpError(409, 'store_required', 'Please finish setting up your seller profile and store address first.');
  return store;
}
