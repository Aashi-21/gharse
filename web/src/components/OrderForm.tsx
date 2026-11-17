import { useRef, useState, type FormEvent } from 'react';
import { Alert, Button, Field, Input, Select, Textarea } from './ui';
import { ApiError } from '../lib/api';
import { INDIAN_STATES } from '../lib/india';
import { inr, PAYMENT_NOTE, type PublicProduct, type PublicStore } from '../lib/publicStore';

interface Confirmation {
  number: number;
  items: { title: string; unitPricePaise: number; quantity: number }[];
  subtotalPaise: number;
  deliveryPaise: number;
  totalPaise: number;
  paymentNote: string;
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Single-product checkout. No account, no payment. All amounts shown here are for information: the server computes the
 * real ones from its own prices. The confirmation is built from what the customer typed plus the server's order
 * number and amounts, because the server never sends personal details back.
 */
export default function OrderForm({ store, product }: { store: PublicStore; product: PublicProduct }) {
  const [f, setF] = useState({ name: '', phone: '', line1: '', line2: '', city: '', state: '', pincode: '', note: '', website: '' });
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ order: Confirmation; name: string; phone: string; address: string } | null>(null);
  // One key per checkout attempt: a double-click or retry reuses it, so the seller can never get two orders.
  const key = useRef(newKey());

  if (!store.checkoutEnabled) {
    return (
      <div className="rounded-2xl border border-cream-300 bg-cream-50 p-5 text-sm text-ink-soft" role="note">
        <p className="font-medium text-ink">Demo store</p>
        <p className="mt-1">This is a sample store, so ordering is switched off. Open a real GharSe store to place an order.</p>
      </div>
    );
  }
  if (!product.inStock) {
    return <p className="rounded-2xl border border-cream-300 bg-cream-50 p-5 text-sm font-medium text-ink-soft">This product is sold out right now.</p>;
  }

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));
  const subtotal = product.pricePaise * quantity;
  const total = subtotal + store.deliveryChargePaise;
  const err = (k: string) => fields[k];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return; // guards against double-clicks
    setBusy(true);
    setError('');
    setFields({});
    try {
      const res = await fetch(`/api/public/stores/${store.slug}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key.current },
        body: JSON.stringify({
          productSlug: product.slug,
          quantity,
          customer: { name: f.name, phone: f.phone },
          address: { line1: f.line1, line2: f.line2, city: f.city, state: f.state, pincode: f.pincode },
          note: f.note,
          website: f.website,
        }),
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const e = data?.error;
        if (e?.code === 'idempotency_conflict') key.current = newKey();
        throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? 'Something went wrong.', e?.fields ?? {});
      }
      setDone({
        order: data.order,
        name: f.name,
        phone: f.phone,
        address: [f.line1, f.line2, f.city, f.state, f.pincode].filter(Boolean).join(', '),
      });
      key.current = newKey(); // the next order from this page is a new order
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      } else {
        setError('We could not reach the store. Please check your connection and try again. Your order was not placed twice if you retry.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    const o = done.order;
    return (
      <div className="rounded-2xl border border-sage/40 bg-sage-light p-5" role="status">
        <h2 className="text-xl font-semibold text-ink">Order placed. Thank you!</h2>
        <p className="mt-1 text-sm text-ink-soft">Your order number is <strong className="text-ink">#{o.number}</strong>. Please note it down.</p>
        <dl className="mt-4 space-y-1 text-sm">
          {o.items.map((i) => (
            <div key={i.title} className="flex justify-between gap-4"><dt>{i.title} × {i.quantity}</dt><dd>{inr(i.unitPricePaise * i.quantity)}</dd></div>
          ))}
          <div className="flex justify-between gap-4"><dt>Delivery</dt><dd>{o.deliveryPaise === 0 ? 'Free' : inr(o.deliveryPaise)}</dd></div>
          <div className="flex justify-between gap-4 border-t border-sage/30 pt-1 font-semibold"><dt>Total to pay the seller</dt><dd>{inr(o.totalPaise)}</dd></div>
        </dl>
        <p className="mt-4 text-sm text-ink-soft">
          Deliver to {done.name}, {done.address}. The seller will contact you on {done.phone} to confirm your order and arrange payment and delivery.
        </p>
        <p className="mt-3 rounded-xl bg-white/70 p-3 text-sm font-medium text-ink">{o.paymentNote}</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-2xl border border-cream-300 bg-white p-5 shadow-card" noValidate aria-label="Place an order">
      <h2 className="text-xl font-semibold">Order this product</h2>
      {error && <Alert>{error}</Alert>}

      <Field label="Quantity" error={err('quantity')}>
        <Select value={quantity} onChange={(e) => setQuantity(Number(e.target.value))}>
          {Array.from({ length: Math.max(1, product.maxQuantity) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
        </Select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your name" error={err('customer.name')}><Input value={f.name} onChange={set('name')} autoComplete="name" maxLength={80} /></Field>
        <Field label="Mobile number" error={err('customer.phone')} hint="The seller will call or message you here">
          <Input value={f.phone} onChange={set('phone')} inputMode="tel" autoComplete="tel" placeholder="98765 43210" />
        </Field>
      </div>
      <Field label="Delivery address" error={err('address.line1')}><Input value={f.line1} onChange={set('line1')} autoComplete="address-line1" maxLength={120} placeholder="House / flat, street" /></Field>
      <Field label="Area or landmark (optional)" error={err('address.line2')}><Input value={f.line2} onChange={set('line2')} autoComplete="address-line2" maxLength={120} /></Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="City" error={err('address.city')}><Input value={f.city} onChange={set('city')} autoComplete="address-level2" maxLength={60} /></Field>
        <Field label="State" error={err('address.state')}>
          <Select value={f.state} onChange={set('state')} autoComplete="address-level1">
            <option value="">Select</option>
            {INDIAN_STATES.map((s) => <option key={s}>{s}</option>)}
          </Select>
        </Field>
        <Field label="PIN code" error={err('address.pincode')}><Input value={f.pincode} onChange={set('pincode')} inputMode="numeric" autoComplete="postal-code" maxLength={6} /></Field>
      </div>
      <Field label="Note for the seller (optional)" error={err('note')}><Textarea rows={2} value={f.note} onChange={set('note')} maxLength={300} /></Field>

      {/* Honeypot: hidden from people, often filled by bots. */}
      <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
        <label>Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} /></label>
      </div>

      <dl className="space-y-1 rounded-xl bg-cream-100 p-4 text-sm">
        <div className="flex justify-between"><dt>{product.title} × {quantity}</dt><dd>{inr(subtotal)}</dd></div>
        <div className="flex justify-between"><dt>Delivery</dt><dd>{store.deliveryChargePaise === 0 ? 'Free' : inr(store.deliveryChargePaise)}</dd></div>
        <div className="flex justify-between border-t border-cream-300 pt-1 text-base font-semibold"><dt>Total</dt><dd>{inr(total)}</dd></div>
      </dl>

      <div className="space-y-2 text-xs text-ink-soft">
        <p><strong className="text-ink">Payment:</strong> {PAYMENT_NOTE} Nothing is charged when you place this order.</p>
        <p><strong className="text-ink">Privacy:</strong> Your name, phone number, address and note are sent only to {store.name} so they can deliver your order. They are not shown publicly and are not used for marketing.</p>
      </div>

      <Button type="submit" loading={busy} className="w-full">Place order</Button>
    </form>
  );
}
