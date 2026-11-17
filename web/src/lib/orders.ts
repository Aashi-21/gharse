export type OrderStatus = 'NEW' | 'CONFIRMED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';

export interface SellerOrder {
  id: string;
  number: number;
  status: OrderStatus;
  customer: { name: string; phone: string };
  address: { line1: string; line2: string | null; city: string; state: string; pincode: string };
  note: string | null;
  items: { title: string; unitPricePaise: number; quantity: number }[];
  subtotalPaise: number;
  deliveryPaise: number;
  totalPaise: number;
  trackingNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  NEW: 'New',
  CONFIRMED: 'Confirmed',
  SHIPPED: 'Shipped',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

export const STATUS_STYLE: Record<OrderStatus, string> = {
  NEW: 'bg-clay-light text-clay-dark',
  CONFIRMED: 'bg-cream-200 text-ink-soft',
  SHIPPED: 'bg-cream-200 text-ink-soft',
  DELIVERED: 'bg-sage-light text-sage',
  CANCELLED: 'bg-red-50 text-red-800',
};

export const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
