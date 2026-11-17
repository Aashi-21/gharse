-- AlterTable (the orders table has no rows yet: order creation did not exist before this migration)
ALTER TABLE "orders" ADD COLUMN     "idempotencyKey" TEXT NOT NULL,
ADD COLUMN     "requestHash" TEXT NOT NULL;

-- CreateIndex: one order per (store, idempotency key). Makes retries and double-clicks safe at the database level.
CREATE UNIQUE INDEX "orders_storeId_idempotencyKey_key" ON "orders"("storeId", "idempotencyKey");

-- Database-level safety net (not modelled by Prisma). The application computes every amount on the server;
-- these make it impossible for a bug to store an order with nonsense numbers.
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_positive_chk" CHECK ("quantity" > 0),
  ADD CONSTRAINT "order_items_unit_price_positive_chk" CHECK ("unitPricePaise" > 0);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_amounts_nonnegative_chk" CHECK ("subtotalPaise" >= 0 AND "deliveryPaise" >= 0 AND "totalPaise" >= 0),
  ADD CONSTRAINT "orders_total_matches_chk" CHECK ("totalPaise" = "subtotalPaise" + "deliveryPaise");
