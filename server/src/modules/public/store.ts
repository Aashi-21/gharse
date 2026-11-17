import type { PrismaClient } from '@prisma/client';
import { HttpError } from '../../lib/httpError';

export const notFound = () => new HttpError(404, 'not_found', 'Not found.');

// Store and product slugs are generated lowercase a-z, 0-9 and single hyphens. Anything else (NUL bytes, slashes,
// spaces, huge strings) can never match, so it is a 404 before the database is touched.
const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const isSlug = (s: string, max: number) => s.length <= max && SLUG_SHAPE.test(s);

/** The one way public routes find a store: published AND with an approved brand, else the same generic 404. */
export async function findPublicStore(prisma: PrismaClient, slugRaw: string) {
  const slug = slugRaw.toLowerCase();
  if (!isSlug(slug, 40)) throw notFound();
  const store = await prisma.store.findFirst({ where: { slug, isPublished: true }, include: { brandProfile: true } });
  if (!store || !store.brandProfile || store.brandProfile.status !== 'APPROVED') throw notFound();
  return { ...store, brandProfile: store.brandProfile };
}
