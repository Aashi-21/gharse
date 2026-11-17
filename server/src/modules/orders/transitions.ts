import type { OrderStatus } from '@prisma/client';

/**
 * The only legal order status changes. DELIVERED and CANCELLED are final.
 * Cancelling is allowed only before the order ships (once it is on its way, the seller and customer sort it out directly).
 */
export const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  NEW: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus) => ALLOWED_TRANSITIONS[from].includes(to);

/** Whether moving to `to` returns the reserved stock to the product. */
export const restocksOn = (to: OrderStatus) => to === 'CANCELLED';
