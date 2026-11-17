import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { OrderStatus } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { ALLOWED_TRANSITIONS } from '../src/modules/orders/transitions';
import { candleListing, fakeAi, liveStore, makeApp, placeOrderRequest, register, resetDb, validOrder } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);
let app: FastifyInstance;
const ai = fakeAi(() => candleListing);
before(async () => ({ app } = await makeApp({}, ai)));
after(async () => app.close());
beforeEach(resetDb);

const ALL: OrderStatus[] = ['NEW', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
const phone = (i: number) => `9${String(100000000 + i)}`;
let n = 0;
type Seller = Awaited<ReturnType<typeof liveStore>>;
/** A real order placed through the public checkout. */
async function place(slug: string, s: Seller, quantity = 1) {
  const i = n++;
  const res = await placeOrderRequest(app, slug, validOrder(s.productSlug, { quantity, customer: { name: `Buyer ${i}`, phone: phone(i) } }));
  assert.equal(res.statusCode, 201, res.body);
  const row = await app.prisma.order.findFirstOrThrow({ where: { orderNumber: json(res).order.number, store: { slug } } });
  return row.id;
}
const list = (cookie: string, qs = '') => app.inject({ method: 'GET', url: `/api/seller/orders${qs}`, headers: { cookie } });
const detail = (cookie: string, id: string) => app.inject({ method: 'GET', url: `/api/seller/orders/${id}`, headers: { cookie } });
const setStatus = (cookie: string, id: string, status: unknown, extra: object = {}) => app.inject({ method: 'PATCH', url: `/api/seller/orders/${id}/status`, headers: { cookie }, payload: { status, ...extra } as object });
const stock = async () => (await app.prisma.product.findFirstOrThrow()).stock;
const rowOf = (id: string) => app.prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true } });

describe('access and ownership', () => {
  it('requires authentication, and a store', async () => {
    for (const [method, url] of [['GET', '/api/seller/orders'], ['GET', '/api/seller/orders/x'], ['PATCH', '/api/seller/orders/x/status']] as const) {
      assert.equal((await app.inject({ method, url, payload: method === 'PATCH' ? { status: 'CONFIRMED' } : undefined })).statusCode, 401, url);
    }
    const { cookie } = await register(app, 'nostore@example.com');
    assert.equal((await list(cookie)).statusCode, 409);
  });

  it('a seller sees only their own store’s orders; others get 404 and cannot change them', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 9 });
    const b = await liveStore(app, 'b@example.com', 'b-store', { stock: 9 });
    const orderA = await place('a-store', a, 2);
    await place('b-store', b);
    assert.deepEqual(json(await list(a.cookie)).orders.map((o: { id: string }) => o.id), [orderA]);
    assert.equal(json(await list(b.cookie)).orders.length, 1);
    const before = await rowOf(orderA);
    const stockBefore = (await app.prisma.product.findFirstOrThrow({ where: { store: { slug: 'a-store' } } })).stock;
    assert.equal((await detail(b.cookie, orderA)).statusCode, 404);
    for (const to of ['CONFIRMED', 'CANCELLED']) {
      const res = await setStatus(b.cookie, orderA, to);
      assert.equal(res.statusCode, 404, to);
      assert.ok(!/Buyer|9\d{9}|MG Road/.test(res.body), 'the 404 reveals nothing about the order');
    }
    assert.deepEqual(await rowOf(orderA), before, 'the order is untouched');
    assert.equal((await app.prisma.product.findFirstOrThrow({ where: { store: { slug: 'a-store' } } })).stock, stockBefore, 'no stock was restored by the foreign cancel attempt');
  });

  it('customer details exist only in seller routes: the public API has no way to read orders', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    await place('a-store', a);
    for (const url of ['/api/public/stores/a-store/orders', '/api/public/stores/a-store', `/api/public/stores/a-store/products/${a.productSlug}`]) {
      const res = await app.inject({ method: 'GET', url });
      assert.ok(!/Buyer \d|91000\d{5}|MG Road|411001|Near the park|call before delivery/.test(res.body), `${url} must not contain customer details`);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/public/stores/a-store/orders' })).statusCode, 404);
  });
});

describe('order list and detail', () => {
  it('shows full seller-side details with a whitelist of fields (no internals)', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 5, price: '499', deliveryCharge: '60' });
    const id = await place('a-store', a, 2);
    const d = json(await detail(a.cookie, id)).order;
    assert.deepEqual(Object.keys(d).sort(), ['address', 'createdAt', 'customer', 'deliveryPaise', 'id', 'items', 'note', 'number', 'status', 'subtotalPaise', 'totalPaise', 'trackingNote', 'updatedAt']);
    assert.deepEqual(d.customer, { name: d.customer.name, phone: d.customer.phone });
    assert.match(d.customer.phone, /^9\d{9}$/);
    assert.deepEqual([d.address.line1, d.address.city, d.address.state, d.address.pincode, d.note], ['12 MG Road', 'Pune', 'Maharashtra', '411001', 'Please call before delivery']);
    assert.deepEqual([d.status, d.subtotalPaise, d.deliveryPaise, d.totalPaise], ['NEW', 99800, 6000, 105800]);
    assert.deepEqual(d.items, [{ title: candleListing.title, unitPricePaise: 49900, quantity: 2 }]);
    const raw = JSON.stringify(json(await list(a.cookie)));
    for (const internal of ['idempotencyKey', 'requestHash', 'storeId']) assert.ok(!raw.includes(internal), `no ${internal} in the list`);
  });

  it('lists newest first, filters by status, and reports per-status counts', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 20 });
    const ids = [await place('a-store', a), await place('a-store', a), await place('a-store', a), await place('a-store', a)];
    await setStatus(a.cookie, ids[1], 'CONFIRMED');
    await setStatus(a.cookie, ids[2], 'CANCELLED');
    const all = json(await list(a.cookie));
    assert.deepEqual(all.orders.map((o: { number: number }) => o.number), [4, 3, 2, 1]);
    assert.deepEqual(all.counts, { NEW: 2, CONFIRMED: 1, SHIPPED: 0, DELIVERED: 0, CANCELLED: 1 });
    assert.deepEqual(json(await list(a.cookie, '?status=NEW')).orders.map((o: { number: number }) => o.number), [4, 1]);
    assert.deepEqual(json(await list(a.cookie, '?status=CANCELLED')).orders.map((o: { number: number }) => o.number), [3]);
  });

  it('paginates with a stable cursor, and rejects bad queries or another seller’s cursor', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 20 });
    const b = await liveStore(app, 'b@example.com', 'b-store', { stock: 20 });
    for (let i = 0; i < 5; i++) await place('a-store', a);
    const bOrder = await place('b-store', b);
    const p1 = json(await list(a.cookie, '?limit=2'));
    assert.deepEqual(p1.orders.map((o: { number: number }) => o.number), [5, 4]);
    const p2 = json(await list(a.cookie, `?limit=2&cursor=${p1.nextCursor}`));
    assert.deepEqual(p2.orders.map((o: { number: number }) => o.number), [3, 2]);
    const p3 = json(await list(a.cookie, `?limit=2&cursor=${p2.nextCursor}`));
    assert.deepEqual(p3.orders.map((o: { number: number }) => o.number), [1]);
    assert.equal(p3.nextCursor, null);
    for (const qs of ['?status=PAID', '?limit=0', '?limit=101', '?limit=abc', `?cursor=${bOrder}`, '?cursor=nope']) {
      assert.equal((await list(a.cookie, qs)).statusCode, 400, qs);
    }
  });

  it('unknown order ids are 404', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store');
    assert.equal((await detail(a.cookie, 'does-not-exist')).statusCode, 404);
    assert.equal((await setStatus(a.cookie, 'does-not-exist', 'CONFIRMED')).statusCode, 404);
  });
});

describe('status transitions', () => {
  it('follows the full 5x5 matrix: legal moves succeed, everything else is a 409 that changes nothing', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 500 });
    for (const from of ALL) {
      for (const to of ALL) {
        const id = await place('a-store', a);
        await app.prisma.order.update({ where: { id }, data: { status: from } });
        const res = await setStatus(a.cookie, id, to);
        if (from === to) {
          assert.equal(res.statusCode, 200, `${from}->${to} (repeat is a harmless no-op)`);
        } else if (ALLOWED_TRANSITIONS[from].includes(to)) {
          assert.equal(res.statusCode, 200, `${from}->${to}`);
          assert.equal((await rowOf(id)).status, to, `${from}->${to}`);
        } else {
          assert.equal(res.statusCode, 409, `${from}->${to}`);
          assert.equal(json(res).error.code, 'invalid_transition');
          assert.equal((await rowOf(id)).status, from, `${from}->${to} left unchanged`);
        }
      }
    }
  });

  it('walks a normal order through its life, and the final states are final', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const id = await place('a-store', a);
    for (const to of ['CONFIRMED', 'SHIPPED', 'DELIVERED']) assert.equal((await setStatus(a.cookie, id, to)).statusCode, 200, to);
    for (const to of ['NEW', 'CONFIRMED', 'SHIPPED', 'CANCELLED']) assert.equal((await setStatus(a.cookie, id, to)).statusCode, 409, `delivered -> ${to}`);
    assert.equal(await stock(), 4, 'a delivered order keeps its stock deducted');
  });

  it('rejects unknown or malformed statuses', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const id = await place('a-store', a);
    for (const bad of ['PAID', 'confirmed', '', null, 5, undefined]) assert.equal((await setStatus(a.cookie, id, bad)).statusCode, 400, String(bad));
    assert.equal((await rowOf(id)).status, 'NEW');
  });

  it('accepts a tracking note only when shipping, and can refresh it', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const id = await place('a-store', a);
    assert.equal((await setStatus(a.cookie, id, 'CONFIRMED', { trackingNote: 'too early' })).statusCode, 400);
    await setStatus(a.cookie, id, 'CONFIRMED');
    assert.equal((await setStatus(a.cookie, id, 'SHIPPED', { trackingNote: 'x'.repeat(201) })).statusCode, 400);
    const shipped = await setStatus(a.cookie, id, 'SHIPPED', { trackingNote: 'India Post, AB123456789IN' });
    assert.equal(json(shipped).order.trackingNote, 'India Post, AB123456789IN');
    assert.equal((await setStatus(a.cookie, id, 'SHIPPED', { trackingNote: 'Delhivery 998877' })).statusCode, 200);
    assert.equal((await rowOf(id)).trackingNote, 'Delhivery 998877');
    assert.equal((await setStatus(a.cookie, id, 'SHIPPED')).statusCode, 200, 'repeating without a note keeps it');
    assert.equal((await rowOf(id)).trackingNote, 'Delhivery 998877');
  });
});

describe('cancelling restores stock exactly once', () => {
  it('returns the reserved units from NEW and from CONFIRMED orders', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 10 });
    const o1 = await place('a-store', a, 3);
    const o2 = await place('a-store', a, 2);
    assert.equal(await stock(), 5);
    await setStatus(a.cookie, o2, 'CONFIRMED');
    assert.equal((await setStatus(a.cookie, o1, 'CANCELLED')).statusCode, 200);
    assert.equal(await stock(), 8);
    assert.equal((await setStatus(a.cookie, o2, 'CANCELLED')).statusCode, 200);
    assert.equal(await stock(), 10);
  });

  it('cancelling again, or a cancelled order being re-confirmed, never restocks twice', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 10 });
    const id = await place('a-store', a, 4);
    await setStatus(a.cookie, id, 'CANCELLED');
    assert.equal(await stock(), 10);
    assert.equal((await setStatus(a.cookie, id, 'CANCELLED')).statusCode, 200, 'double-click');
    assert.equal(await stock(), 10, 'no second restock');
    assert.equal((await setStatus(a.cookie, id, 'CONFIRMED')).statusCode, 409);
    assert.equal(await stock(), 10);
  });

  it('6 simultaneous cancel requests restore the stock once', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 10 });
    const id = await place('a-store', a, 4);
    const results = await Promise.all(Array.from({ length: 6 }, () => setStatus(a.cookie, id, 'CANCELLED')));
    assert.ok(results.every((r) => r.statusCode === 200), `statuses: ${results.map((r) => r.statusCode)}`);
    assert.equal(await stock(), 10, 'exactly 4 units came back, once');
  });

  it('a cancel racing a ship from CONFIRMED has one winner, and stock matches it', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 100 });
    for (let i = 0; i < 6; i++) {
      const id = await place('a-store', a, 2);
      await setStatus(a.cookie, id, 'CONFIRMED');
      const before = await stock();
      const [ship, cancel] = await Promise.all([setStatus(a.cookie, id, 'SHIPPED'), setStatus(a.cookie, id, 'CANCELLED')]);
      const final = (await rowOf(id)).status;
      assert.ok(final === 'SHIPPED' || final === 'CANCELLED', `final ${final}`);
      assert.deepEqual([ship.statusCode, cancel.statusCode].sort(), [200, 409], 'one succeeded, one was refused');
      assert.equal(await stock(), final === 'CANCELLED' ? before + 2 : before, `stock is consistent with ${final}`);
    }
  });

  it('restores stock even if the product was meanwhile unpublished, archived or repriced', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 10, price: '499' });
    const id = await place('a-store', a, 3);
    await app.inject({ method: 'POST', url: `/api/seller/products/${a.productId}/unpublish`, headers: { cookie: a.cookie } });
    await app.prisma.product.update({ where: { id: a.productId }, data: { status: 'ARCHIVED', pricePaise: 12345 } });
    await setStatus(a.cookie, id, 'CANCELLED');
    assert.equal(await stock(), 10);
    assert.equal((await rowOf(id)).items[0].unitPricePaise, 49900, 'the order keeps its original price snapshot');
  });

  it('a cancelled order makes the product orderable again after it was sold out', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 1 });
    const id = await place('a-store', a);
    const soldOut = await placeOrderRequest(app, 'a-store', validOrder(a.productSlug));
    assert.equal(json(soldOut).error.code, 'out_of_stock');
    await setStatus(a.cookie, id, 'CANCELLED');
    assert.equal((await placeOrderRequest(app, 'a-store', validOrder(a.productSlug))).statusCode, 201);
  });

  it('survives an order whose product row was deleted (history is kept, nothing to restock)', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const id = await place('a-store', a);
    await app.prisma.product.delete({ where: { id: a.productId } });
    assert.equal((await rowOf(id)).items[0].productId, null);
    assert.equal((await setStatus(a.cookie, id, 'CANCELLED')).statusCode, 200);
    assert.equal((await rowOf(id)).status, 'CANCELLED');
  });
});

describe('dashboard badge', () => {
  it('/api/auth/me reports NEW orders for this seller only, and updates as statuses change', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 20 });
    const b = await liveStore(app, 'b@example.com', 'b-store', { stock: 20 });
    const me = async (c: string) => json(await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: c } }));
    assert.equal((await me(a.cookie)).newOrders, 0);
    const o1 = await place('a-store', a);
    await place('a-store', a);
    await place('b-store', b);
    assert.equal((await me(a.cookie)).newOrders, 2);
    assert.equal((await me(b.cookie)).newOrders, 1);
    await setStatus(a.cookie, o1, 'CONFIRMED');
    assert.equal((await me(a.cookie)).newOrders, 1);
    assert.deepEqual((await me(a.cookie)).counts, { products: 1, published: 1 }, 'the existing counts object is unchanged');
  });
});
