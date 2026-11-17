-- AlterTable
ALTER TABLE "products" ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- Backfill: rows that were already PUBLISHED (the seeded sample store) get a publish time so the new
-- constraint below holds for them. Nothing is un-published and no price/stock is invented.
UPDATE "products" SET "publishedAt" = "createdAt" WHERE "status" = 'PUBLISHED' AND "publishedAt" IS NULL;

-- Database-level safety net (not modelled by Prisma). The application validates first; these guarantee that
-- no bug elsewhere can ever leave a live product without a price, a title or a publish time.
ALTER TABLE "products"
  ADD CONSTRAINT "products_published_requires_price_chk"
    CHECK ("status" <> 'PUBLISHED' OR ("pricePaise" IS NOT NULL AND "pricePaise" > 0)),
  ADD CONSTRAINT "products_published_requires_title_chk"
    CHECK ("status" <> 'PUBLISHED' OR char_length(btrim("title")) >= 2),
  ADD CONSTRAINT "products_published_requires_publishedat_chk"
    CHECK ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL),
  ADD CONSTRAINT "products_stock_nonnegative_chk"
    CHECK ("stock" >= 0);
