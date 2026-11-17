import type { Prisma } from '@prisma/client';
import { HttpError } from '../../lib/httpError';
import type { Storage } from '../../lib/storage';

/** Minimum description length (characters) for a product to be publishable or to stay live. */
export const MIN_DESCRIPTION_LENGTH = 20;

export interface PublishIssue {
  field: 'title' | 'description' | 'category' | 'price' | 'stock' | 'image';
  message: string;
}

export interface PublishCandidate {
  title: string;
  description: string;
  category: string | null;
  pricePaise: number | null;
  stock: number;
}

/**
 * The single, backend-authoritative definition of "ready to sell". Returns every problem (empty = OK).
 *
 *  - Publishing (`live: false`) needs stock of at least 1.
 *  - A product that is ALREADY live (`live: true`) must keep everything else, but may drop to stock 0 (sold out).
 *
 * Tags are optional. Nothing here ever fills in a missing value.
 */
export function getPublishIssues(p: PublishCandidate, imageCount: number, opts: { live: boolean }): PublishIssue[] {
  const issues: PublishIssue[] = [];
  if (p.title.trim().length < 2) issues.push({ field: 'title', message: 'Add a title.' });
  if (p.description.trim().length < MIN_DESCRIPTION_LENGTH) {
    issues.push({ field: 'description', message: `Write a description of at least ${MIN_DESCRIPTION_LENGTH} characters.` });
  }
  if (!p.category) issues.push({ field: 'category', message: 'Choose a category.' });
  if (p.pricePaise === null || p.pricePaise <= 0) issues.push({ field: 'price', message: 'Enter the price in rupees.' });
  if (!opts.live && p.stock < 1) issues.push({ field: 'stock', message: 'Enter how many you have in stock (at least 1).' });
  if (imageCount < 1) issues.push({ field: 'image', message: 'Add a product photo.' });
  return issues;
}

export const issuesToFields = (issues: PublishIssue[]): Record<string, string> =>
  Object.fromEntries(issues.map((i) => [i.field, i.message]));

/**
 * Takes a row lock on the seller's own product and returns it with its images.
 * Every state change (publish, unpublish, edits to live products, regeneration) goes through this inside a
 * transaction, so a concurrent request can never slip a change between "validate" and "write".
 * Scoping by storeId here means another seller's product is simply "not found".
 */
export async function lockOwnedProduct(tx: Prisma.TransactionClient, storeId: string, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM products WHERE id = ${id} AND "storeId" = ${storeId} FOR UPDATE`;
  if (rows.length === 0) throw new HttpError(404, 'not_found', 'Product not found.');
  return tx.product.findUniqueOrThrow({ where: { id }, include: { images: true } });
}

/** Shown to the seller when a photo row exists but its file cannot be found or read. Never includes paths or keys. */
export const IMAGE_UNAVAILABLE_MESSAGE =
  'The photo for this product could not be found in storage, so it cannot be published yet. Please add the product again with a new photo.';

/**
 * A photo counts for publishing only if its file is really there: a regular file that is non-empty and exactly the
 * size recorded at upload (catches truncated or replaced files). Metadata only: no file content is read.
 */
export async function isImageUsable(storage: Storage, image: { storageKey: string; sizeBytes: number }): Promise<boolean> {
  const st = await storage.stat(image.storageKey);
  return st !== null && st.size > 0 && st.size === image.sizeBytes;
}
