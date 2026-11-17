import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { inr } from '../lib/publicStore';
import { STATUS_LABEL, STATUS_STYLE, when, type OrderStatus, type SellerOrder } from '../lib/orders';

const TABS: (OrderStatus | 'ALL')[] = ['ALL', 'NEW', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
type Counts = Record<OrderStatus, number>;

export default function OrdersPage() {
  const [tab, setTab] = useState<OrderStatus | 'ALL'>('ALL');
  const [orders, setOrders] = useState<SellerOrder[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [more, setMore] = useState(false);

  const load = useCallback(async (status: OrderStatus | 'ALL', after?: string) => {
    const qs = new URLSearchParams({ limit: '25' });
    if (status !== 'ALL') qs.set('status', status);
    if (after) qs.set('cursor', after);
    return api<{ orders: SellerOrder[]; nextCursor: string | null; counts: Counts }>(`/api/seller/orders?${qs}`);
  }, []);

  useEffect(() => {
    setOrders(null);
    setError('');
    load(tab)
      .then((r) => {
        setOrders(r.orders);
        setCursor(r.nextCursor);
        setCounts(r.counts);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load your orders.'));
  }, [tab, load]);

  async function loadMore() {
    if (!cursor) return;
    setMore(true);
    try {
      const r = await load(tab, cursor);
      setOrders((p) => [...(p ?? []), ...r.orders]);
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load more orders.');
    } finally {
      setMore(false);
    }
  }

  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Orders</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">Customers order from your store without an account. GharSe collects no payment: you arrange payment and delivery with each customer directly.</p>
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter orders by status">
        {TABS.map((t) => {
          const n = t === 'ALL' ? total : counts?.[t] ?? 0;
          return (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-full border px-4 py-1.5 text-sm ${tab === t ? 'border-clay bg-clay-light text-clay-dark' : 'border-cream-300 bg-white text-ink-soft hover:bg-cream-200'}`}
            >
              {t === 'ALL' ? 'All' : STATUS_LABEL[t]} <span className="text-xs opacity-70">{counts ? n : ''}</span>
            </button>
          );
        })}
      </div>

      {error && <Alert>{error}</Alert>}
      {!orders && !error && <div className="flex justify-center py-16 text-clay"><Spinner className="h-7 w-7" /></div>}

      {orders && orders.length === 0 && (
        <Card className="py-12 text-center">
          <h2 className="text-xl font-semibold">{tab === 'ALL' ? 'No orders yet' : `No ${STATUS_LABEL[tab as OrderStatus].toLowerCase()} orders`}</h2>
          {tab === 'ALL' && <p className="mx-auto mt-2 max-w-md text-sm text-ink-soft">When a customer orders from your store, it appears here. Share your store link to get started.</p>}
        </Card>
      )}

      {orders && orders.length > 0 && (
        <ul className="space-y-3">
          {orders.map((o) => (
            <li key={o.id}>
              <Link to={`/dashboard/orders/${o.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-cream-300 bg-white p-4 shadow-card transition hover:shadow-md">
                <div>
                  <p className="font-medium">Order #{o.number} · {o.customer.name}</p>
                  <p className="text-sm text-ink-soft">{o.items.map((i) => `${i.title} × ${i.quantity}`).join(', ')}</p>
                  <p className="text-xs text-ink-faint">{when(o.createdAt)} · {o.address.city}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-semibold">{inr(o.totalPaise)}</span>
                  <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLE[o.status]}`}>{STATUS_LABEL[o.status]}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {cursor && <Button variant="secondary" loading={more} onClick={loadMore}>Load more</Button>}
    </div>
  );
}
