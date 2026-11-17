import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Field, Input, Spinner } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { inr } from '../lib/publicStore';
import { STATUS_LABEL, STATUS_STYLE, when, type OrderStatus, type SellerOrder } from '../lib/orders';

// Display only: the backend enforces the real rules.
const NEXT: Record<OrderStatus, OrderStatus[]> = { NEW: ['CONFIRMED', 'CANCELLED'], CONFIRMED: ['SHIPPED', 'CANCELLED'], SHIPPED: ['DELIVERED'], DELIVERED: [], CANCELLED: [] };
const ACTION: Record<string, string> = { CONFIRMED: 'Confirm order', SHIPPED: 'Mark as shipped', DELIVERED: 'Mark as delivered', CANCELLED: 'Cancel order' };

export default function OrderDetailPage() {
  const { id } = useParams();
  const { refresh } = useAuth(); // keeps the new-order badge in step
  const [order, setOrder] = useState<SellerOrder | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState<OrderStatus | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tracking, setTracking] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    api<{ order: SellerOrder }>(`/api/seller/orders/${id}`)
      .then((r) => {
        setOrder(r.order);
        setTracking(r.order.trackingNote ?? '');
      })
      .catch((e) => setLoadError(e instanceof ApiError && e.status === 404 ? 'We could not find this order.' : 'Could not load this order.'));
  }, [id]);

  if (loadError) return <Alert>{loadError} <Link to="/dashboard/orders" className="font-medium underline">Back to orders</Link></Alert>;
  if (!order) return <div className="flex justify-center py-20 text-clay"><Spinner className="h-7 w-7" /></div>;

  async function move(to: OrderStatus) {
    setBusy(to);
    setError('');
    setNotice('');
    setConfirmCancel(false);
    try {
      const r = await api<{ order: SellerOrder }>(`/api/seller/orders/${order!.id}/status`, {
        method: 'PATCH',
        body: { status: to, ...(to === 'SHIPPED' && tracking.trim() ? { trackingNote: tracking.trim() } : {}) },
      });
      setOrder(r.order);
      setNotice(to === 'CANCELLED' ? 'Order cancelled. The reserved stock was returned to the product.' : `Order marked as ${STATUS_LABEL[to].toLowerCase()}.`);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(null);
    }
  }

  const a = order.address;
  const actions = NEXT[order.status];
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Link to="/dashboard/orders" className="text-sm text-ink-soft hover:underline">← All orders</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold">Order #{order.number}</h1>
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLE[order.status]}`}>{STATUS_LABEL[order.status]}</span>
        </div>
        <p className="mt-1 text-sm text-ink-soft">Placed {when(order.createdAt)}</p>
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && !error && <Alert kind="success">{notice}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="!p-5">
          <h2 className="font-semibold">Customer</h2>
          <p className="mt-2 text-sm">{order.customer.name}</p>
          <p className="text-sm"><a href={`tel:+91${order.customer.phone}`} className="text-clay-dark hover:underline">+91 {order.customer.phone}</a></p>
          <p className="mt-1 text-sm"><a href={`https://wa.me/91${order.customer.phone}`} target="_blank" rel="noreferrer" className="text-clay-dark hover:underline">Message on WhatsApp</a></p>
        </Card>
        <Card className="!p-5">
          <h2 className="font-semibold">Deliver to</h2>
          <address className="mt-2 text-sm not-italic text-ink-soft">
            {a.line1}<br />{a.line2 && <>{a.line2}<br /></>}{a.city}, {a.state} {a.pincode}
          </address>
        </Card>
      </div>

      {order.note && (
        <Card className="!p-5">
          <h2 className="font-semibold">Customer’s note</h2>
          <p className="mt-2 whitespace-pre-line text-sm text-ink-soft">{order.note}</p>
        </Card>
      )}

      <Card className="!p-5">
        <h2 className="font-semibold">Items</h2>
        <dl className="mt-3 space-y-1 text-sm">
          {order.items.map((i) => (
            <div key={i.title} className="flex justify-between gap-4"><dt>{i.title} × {i.quantity} <span className="text-ink-faint">({inr(i.unitPricePaise)} each)</span></dt><dd>{inr(i.unitPricePaise * i.quantity)}</dd></div>
          ))}
          <div className="flex justify-between gap-4"><dt>Delivery</dt><dd>{order.deliveryPaise === 0 ? 'Free' : inr(order.deliveryPaise)}</dd></div>
          <div className="flex justify-between gap-4 border-t border-cream-200 pt-2 text-base font-semibold"><dt>Customer owes you</dt><dd>{inr(order.totalPaise)}</dd></div>
        </dl>
        <p className="mt-3 rounded-xl bg-cream-100 p-3 text-xs text-ink-soft">GharSe has not collected any payment for this order. Arrange payment (for example cash on delivery) directly with the customer.</p>
      </Card>

      {order.trackingNote && order.status !== 'CONFIRMED' && (
        <Card className="!p-5">
          <h2 className="font-semibold">Tracking</h2>
          <p className="mt-2 text-sm text-ink-soft">{order.trackingNote}</p>
        </Card>
      )}

      {actions.length > 0 ? (
        <Card className="space-y-4 !p-5">
          <h2 className="font-semibold">Update this order</h2>
          {actions.includes('SHIPPED') && (
            <Field label="Tracking note (optional)" hint="For example the courier name and tracking number.">
              <Input value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={200} />
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {actions.filter((t) => t !== 'CANCELLED').map((t) => (
              <Button key={t} loading={busy === t} disabled={busy !== null && busy !== t} onClick={() => move(t)}>{ACTION[t]}</Button>
            ))}
            {actions.includes('CANCELLED') && !confirmCancel && (
              <Button variant="secondary" disabled={busy !== null} onClick={() => setConfirmCancel(true)}>Cancel order</Button>
            )}
          </div>
          {confirmCancel && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-clay/30 bg-clay-light p-3 text-sm text-clay-dark" role="alertdialog" aria-label="Confirm cancellation">
              <span>Cancel this order? The reserved stock goes back to the product. This cannot be undone.</span>
              <Button loading={busy === 'CANCELLED'} onClick={() => move('CANCELLED')}>Yes, cancel it</Button>
              <Button variant="ghost" onClick={() => setConfirmCancel(false)}>Keep order</Button>
            </div>
          )}
        </Card>
      ) : (
        <p className="text-sm text-ink-faint">This order is {STATUS_LABEL[order.status].toLowerCase()}, so it can no longer be changed.</p>
      )}
    </div>
  );
}
