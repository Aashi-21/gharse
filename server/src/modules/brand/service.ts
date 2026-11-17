import type { BrandProfile, PrismaClient } from '@prisma/client';
import { HttpError } from '../../lib/httpError';

/**
 * Brand memory: the seller's approved brand is always read fresh from PostgreSQL, keyed by the
 * authenticated seller's store. Nothing here (or in any AI call) depends on chat history or browser state.
 */
export async function getApprovedBrand(prisma: PrismaClient, storeId: string): Promise<BrandProfile> {
  const brand = await prisma.brandProfile.findFirst({ where: { storeId, status: 'APPROVED' } });
  if (!brand) {
    throw new HttpError(409, 'brand_required', 'Please create and approve your brand before adding products, so your listings match your brand voice.');
  }
  return brand;
}
