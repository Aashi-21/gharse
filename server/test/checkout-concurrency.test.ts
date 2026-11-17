import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { candleListing, fakeAi, liveStore, makeApp, newKey, placeOrderRequest, resetDb, validOrder } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);
let app: FastifyInstance;
const ai = fakeAi(() => candleListing);
before(async () => ({ app } = await makeApp({}, ai)));
after(async () => app.close());
beforeEach(resetDb);

const phone = (i: number) => `9${String(100000000 + i)}`; // valid, distinct 10-digit mobile numbers
const order = (slug: string, i: number, over: Record<string, unknown> = {}) =>
  validOrder(slug, { customer: { name: `Buyer ${i}`, phone: phone(i) }, ...over });
const rows = () => app.prisma.order.findMany({ orderBy: { orderNumber: 'asc' }, include: { items: true } });
const stock = async () => (await app.prisma.product.findFirstOrThrow()).stock;
const count = <T,>(xs: T[], f: (x: T) => boolean) => xs.filter(f).length;

describe('concurrent checkout can never oversell', () => {
  it('20 simultaneous buyers of the last 5 units: exactly 5 orders, 15 clean refusals, stock 0', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => placeOrderRequest(app, 'a-store', order(s.productSlug, i))));
    const ok = results.filter((r) => r.statusCode === 201);
    const refused = results.filter((r) => r.statusCode === 409);
    assert.equal(ok.length, 5, `201s: ${results.map((r) => r.statusCode).join(',')}`);
    assert.equal(refused.length, 15, 'every other buyer got a clean 409');
    assert.ok(refused.every((r) => json(r).error.code === 'out_of_stock'), 'refusals are out_of_stock');
    assert.equal(await stock(), 0, 'stock is exactly zero, never negative');
    const all = await rows();
    assert.equal(all.length, 5);
    assert.deepEqual(all.map((o) => o.orderNumber), [1, 2, 3, 4, 5], 'contiguous, unique order numbers');
    assert.equal(all.reduce((n, o) => n + o.items[0].quantity, 0), 5, 'units sold = units that existed');
    assert.equal((await app.prisma.store.findFirstOrThrow()).nextOrderNumber, 6, 'failed attempts consumed no order numbers');
  });

  it('two buyers wanting 3 of 5: one succeeds, the other is told only 2 are left', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const [x, y] = await Promise.all([0, 1].map((i) => placeOrderRequest(app, 'a-store', order(s.productSlug, i, { quantity: 3 }))));
    assert.deepEqual([x.statusCode, y.statusCode].sort(), [201, 409]);
    const loser = x.statusCode === 409 ? x : y;
    assert.equal(json(loser).error.fields.quantity, 'Only 2 left');
    assert.equal(await stock(), 2);
    assert.equal((await rows()).length, 1);
  });

  it('mixed quantities racing for limited stock never exceed it', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 10 });
    const quantities = [4, 3, 3, 2, 2, 1, 1, 5, 6, 2, 1, 3];
    const results = await Promise.all(quantities.map((q, i) => placeOrderRequest(app, 'a-store', order(s.productSlug, i, { quantity: q }))));
    const sold = (await rows()).reduce((n, o) => n + o.items[0].quantity, 0);
    assert.ok(sold <= 10, `sold ${sold} units of 10`);
    assert.equal(await stock(), 10 - sold, 'stock equals what was not sold');
    assert.equal(count(results, (r) => r.statusCode === 201), (await rows()).length, 'one order per success');
    assert.ok(results.every((r) => r.statusCode === 201 || r.statusCode === 409), 'only clean outcomes');
  });
});

describe('concurrent duplicate requests (double-click / retry storm) create one order', () => {
  it('12 simultaneous identical requests with the same key: one order, stock taken once', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const key = newKey();
    const results = await Promise.all(Array.from({ length: 12 }, () => placeOrderRequest(app, 'a-store', order(s.productSlug, 1, { quantity: 2 }), key)));
    assert.equal(count(results, (r) => r.statusCode === 201), 1, `statuses: ${results.map((r) => r.statusCode).join(',')}`);
    assert.equal(count(results, (r) => r.statusCode === 200), 11, 'all the others are replays of that order');
    assert.equal(new Set(results.map((r) => json(r).order.number)).size, 1, 'everyone sees the same order number');
    assert.equal((await rows()).length, 1);
    assert.equal(await stock(), 3, 'decremented exactly once (5 - 2)');
  });

  it('the LAST unit with a duplicate storm: a replay is never turned into "sold out"', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 1 });
    const key = newKey();
    const results = await Promise.all(Array.from({ length: 8 }, () => placeOrderRequest(app, 'a-store', order(s.productSlug, 1), key)));
    assert.equal(count(results, (r) => r.statusCode === 201), 1);
    assert.equal(count(results, (r) => r.statusCode === 200), 7, 'the rest are replays, not 409 out_of_stock');
    assert.equal(await stock(), 0);
    assert.equal((await rows()).length, 1);
  });

  it('10 buyers each double- or triple-clicking, 6 units: exactly 6 orders, consistent replays', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 6 });
    const keys = Array.from({ length: 10 }, () => newKey());
    const reqs = keys.flatMap((key, i) => Array.from({ length: 3 }, () => ({ key, i })));
    const results = await Promise.all(reqs.map(({ key, i }) => placeOrderRequest(app, 'a-store', order(s.productSlug, i), key).then((r) => ({ key, r }))));
    assert.equal((await rows()).length, 6, 'exactly 6 distinct orders for 6 units');
    assert.equal(await stock(), 0);
    for (const key of keys) {
      const mine = results.filter((x) => x.key === key).map((x) => x.r);
      const numbers = new Set(mine.filter((r) => r.statusCode === 200 || r.statusCode === 201).map((r) => json(r).order.number));
      if (numbers.size > 0) {
        assert.equal(numbers.size, 1, 'every success for one key refers to one order');
        assert.equal(count(mine, (r) => r.statusCode === 201), 1, 'created once');
        assert.equal(mine.length, count(mine, (r) => r.statusCode === 200 || r.statusCode === 201), 'no refusals for a key that has an order');
      } else {
        assert.ok(mine.every((r) => r.statusCode === 409), 'a key without an order is consistently refused');
      }
    }
  });

  it('same key, different requests, concurrently: at most one wins, the rest conflict', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const key = newKey();
    const results = await Promise.all([1, 2, 3, 4].map((q) => placeOrderRequest(app, 'a-store', order(s.productSlug, 1, { quantity: q }), key)));
    assert.equal(count(results, (r) => r.statusCode === 201), 1);
    assert.ok(results.every((r) => [201, 409].includes(r.statusCode)), 'others conflict, never create another order');
    assert.equal((await rows()).length, 1);
    const sold = (await rows())[0].items[0].quantity;
    assert.equal(await stock(), 5 - sold);
  });
});

describe('concurrency across stores and with the seller', () => {
  it('stores are fully independent: parallel orders to two stores number and stock separately', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 3 });
    const b = await liveStore(app, 'b@example.com', 'b-store', { stock: 3 });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => placeOrderRequest(app, i % 2 ? 'a-store' : 'b-store', order(i % 2 ? a.productSlug : b.productSlug, i))));
    assert.equal(count(results, (r) => r.statusCode === 201), 6, '3 per store');
    const all = await app.prisma.order.findMany({ include: { store: true } });
    for (const slug of ['a-store', 'b-store']) {
      assert.deepEqual(all.filter((o) => o.store.slug === slug).map((o) => o.orderNumber).sort(), [1, 2, 3], slug);
    }
    assert.deepEqual((await app.prisma.product.findMany()).map((p) => p.stock), [0, 0]);
  });

  it('a seller unpublishing the product while customers order: stock matches the orders that were accepted', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 8 });
    const buyers = Array.from({ length: 10 }, (_, i) => placeOrderRequest(app, 'a-store', order(s.productSlug, i)));
    const unpublish = app.inject({ method: 'POST', url: `/api/seller/products/${s.productId}/unpublish`, headers: { cookie: s.cookie } });
    const [results] = await Promise.all([Promise.all(buyers), unpublish]);
    const accepted = count(results, (r) => r.statusCode === 201);
    assert.equal((await rows()).length, accepted);
    assert.equal(await stock(), 8 - accepted, 'every unit taken has an order, every order took a unit');
    assert.ok(results.every((r) => [201, 409].includes(r.statusCode)), 'only clean outcomes');
  });
});
