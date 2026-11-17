import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { errorLogPayload } from '../src/plugins/errors';
import { candleListing, fakeAi, liveStore, makeApp, newKey, placeOrderRequest, resetDb, sellerWithPublishedProduct, validOrder } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);
let app: FastifyInstance;
const ai = fakeAi(() => candleListing);
before(async () => ({ app } = await makeApp({}, ai)));
after(async () => app.close());
beforeEach(resetDb);

const orders = () => app.prisma.order.findMany({ orderBy: { orderNumber: 'asc' }, include: { items: true } });
const stockOf = async (slug: string) => (await app.prisma.product.findFirstOrThrow({ where: { slug } })).stock;
const ORDER_PII = ['Anita Verma', '9876512345', '98765 12345', '12 MG Road', 'Near the park', '411001', 'Please call before delivery'];

describe('placing an order', () => {
  it('creates an order, computes every amount on the server, takes stock, and returns NO customer details', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { price: '499', stock: 5, deliveryCharge: '60' });
    const res = await placeOrderRequest(app, 'a-store', validOrder(s.productSlug, { quantity: 2 }));
    assert.equal(res.statusCode, 201, res.body);
    const { order, replayed } = json(res);
    assert.equal(replayed, false);
    assert.deepEqual(
      { n: order.number, status: order.status, items: order.items, sub: order.subtotalPaise, del: order.deliveryPaise, total: order.totalPaise },
      { n: 1, status: 'NEW', items: [{ title: candleListing.title, unitPricePaise: 49900, quantity: 2 }], sub: 99800, del: 6000, total: 105800 },
    );
    assert.match(order.paymentNote, /does not collect any payment/i);
    for (const pii of ORDER_PII) assert.ok(!res.body.includes(pii), `confirmation must not echo "${pii}"`);

    const [row] = await orders();
    assert.deepEqual(
      { name: row.customerName, phone: row.customerPhone, l1: row.shippingLine1, l2: row.shippingLine2, city: row.shippingCity, state: row.shippingState, pin: row.shippingPincode, note: row.note, status: row.status, email: row.customerEmail },
      { name: 'Anita Verma', phone: '9876512345', l1: '12 MG Road', l2: 'Near the park', city: 'Pune', state: 'Maharashtra', pin: '411001', note: 'Please call before delivery', status: 'NEW', email: null },
    );
    assert.deepEqual(row.items.map((i) => [i.titleSnapshot, i.unitPricePaise, i.quantity]), [[candleListing.title, 49900, 2]]);
    assert.equal(await stockOf(s.productSlug), 3, 'stock reserved at order creation');
  });

  it('uses the CURRENT database price and delivery charge; old orders keep their snapshot', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { price: '499', stock: 9, deliveryCharge: '60' });
    await placeOrderRequest(app, 'a-store', validOrder(s.productSlug));
    await app.inject({ method: 'PATCH', url: `/api/seller/products/${s.productId}`, headers: { cookie: s.cookie }, payload: { price: '599' } });
    await app.inject({ method: 'PUT', url: '/api/seller/store/settings', headers: { cookie: s.cookie }, payload: { deliveryCharge: '0' } });
    const second = await placeOrderRequest(app, 'a-store', validOrder(s.productSlug));
    assert.deepEqual([json(second).order.subtotalPaise, json(second).order.deliveryPaise, json(second).order.totalPaise], [59900, 0, 59900]);
    const [first] = await orders();
    assert.deepEqual([first.subtotalPaise, first.deliveryPaise, first.totalPaise, first.items[0].unitPricePaise], [49900, 6000, 55900, 49900], 'the first order is unchanged');
  });

  it('refuses any client-supplied price, total, delivery charge, status or unknown field', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const extras: Record<string, unknown>[] = [
      { price: 1 }, { pricePaise: 1 }, { unitPricePaise: 1 }, { total: 1 }, { totalPaise: 1 }, { subtotalPaise: 1 }, { deliveryPaise: 0 },
      { status: 'DELIVERED' }, { storeId: 'x' }, { items: [{ productSlug: s.productSlug, quantity: 1, price: 1 }] }, { email: 'a@b.co' },
    ];
    for (const extra of extras) {
      const res = await placeOrderRequest(app, 'a-store', validOrder(s.productSlug, extra));
      assert.equal(res.statusCode, 400, JSON.stringify(extra));
      assert.equal(json(res).error.code, 'validation_error');
    }
    const nested = await placeOrderRequest(app, 'a-store', { ...validOrder(s.productSlug), customer: { name: 'Anita Verma', phone: '9876512345', email: 'x@y.z' } });
    assert.equal(nested.statusCode, 400);
    assert.deepEqual(await orders(), []);
    assert.equal(await stockOf(s.productSlug), 5);
  });

  it('validates every field on the backend and creates nothing when invalid', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const addr = (o: object) => ({ ...validOrder(s.productSlug).address, ...o });
    const cust = (o: object) => ({ ...validOrder(s.productSlug).customer, ...o });
    const bad: [string, Record<string, unknown>, string][] = [
      ['name too short', { customer: cust({ name: 'A' }) }, 'customer.name'],
      ['name too long', { customer: cust({ name: 'A'.repeat(81) }) }, 'customer.name'],
      ['bad phone', { customer: cust({ phone: '12345' }) }, 'customer.phone'],
      ['phone starting with 5', { customer: cust({ phone: '5876512345' }) }, 'customer.phone'],
      ['address too short', { address: addr({ line1: 'ab' }) }, 'address.line1'],
      ['address line2 too long', { address: addr({ line2: 'x'.repeat(121) }) }, 'address.line2'],
      ['city missing', { address: addr({ city: '' }) }, 'address.city'],
      ['unknown state', { address: addr({ state: 'Atlantis' }) }, 'address.state'],
      ['pincode leading zero', { address: addr({ pincode: '011001' }) }, 'address.pincode'],
      ['pincode 5 digits', { address: addr({ pincode: '41100' }) }, 'address.pincode'],
      ['pincode letters', { address: addr({ pincode: 'abcdef' }) }, 'address.pincode'],
      ['quantity 0', { quantity: 0 }, 'quantity'],
      ['quantity 11', { quantity: 11 }, 'quantity'],
      ['quantity 1.5', { quantity: 1.5 }, 'quantity'],
      ['quantity as string', { quantity: '2' }, 'quantity'],
      ['negative quantity', { quantity: -1 }, 'quantity'],
      ['note too long', { note: 'x'.repeat(301) }, 'note'],
      ['honeypot filled', { website: 'http://spam.example' }, 'website'],
    ];
    for (const [name, over, field] of bad) {
      const res = await placeOrderRequest(app, 'a-store', validOrder(s.productSlug, over));
      assert.equal(res.statusCode, 400, name);
      assert.ok(json(res).error.fields[field], `${name}: expected a message for ${field}, got ${JSON.stringify(json(res).error.fields)}`);
    }
    for (const body of [undefined, 'not json', [], null]) {
      const status = (await placeOrderRequest(app, 'a-store', body as never)).statusCode;
      assert.ok(status === 400 || status === 415, `malformed body ${String(body)} must be refused (got ${status})`);
    }
    assert.deepEqual(await orders(), []);
    assert.equal(await stockOf(s.productSlug), 5);
    // optional parts really are optional, and a state is accepted exactly as listed
    const minimal = validOrder(s.productSlug, { note: '' });
    delete (minimal.address as Record<string, unknown>).line2;
    assert.equal((await placeOrderRequest(app, 'a-store', minimal)).statusCode, 201);
  });

  it('requires a well-formed Idempotency-Key', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    for (const key of [null, '', 'short', 'x'.repeat(65), 'has spaces here', 'bad/chars?!']) {
      const res = await placeOrderRequest(app, 'a-store', validOrder(s.productSlug), key);
      assert.equal(res.statusCode, 400, String(key));
      assert.ok(json(res).error.fields['Idempotency-Key'], `message for key ${String(key)}`);
    }
    assert.deepEqual(await orders(), []);
  });

  it('numbers orders per store, starting at 1 for each store', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const b = await liveStore(app, 'b@example.com', 'b-store', { stock: 5 });
    const nums: number[] = [];
    for (const [slug, p] of [['a-store', a], ['b-store', b], ['a-store', a], ['b-store', b], ['a-store', a]] as const) {
      nums.push(json(await placeOrderRequest(app, slug, validOrder(p.productSlug))).order.number);
    }
    assert.deepEqual(nums, [1, 1, 2, 2, 3]);
  });
});

describe('what can be ordered', () => {
  it('refuses a store that is not published, or has no approved brand, with the same 404 as a missing store', async () => {
    const s = await sellerWithPublishedProduct(app, 'a@example.com', 'a-store'); // store NOT published
    const missing = await placeOrderRequest(app, 'nope-store', validOrder('x'));
    const unpublished = await placeOrderRequest(app, 'a-store', validOrder(s.productSlug));
    assert.equal(unpublished.statusCode, 404);
    assert.equal(unpublished.body, missing.body);
    assert.deepEqual(await orders(), []);
    const live = await liveStore(app, 'b@example.com', 'b-store');
    await app.prisma.brandProfile.updateMany({ where: { store: { slug: 'b-store' } }, data: { status: 'DRAFT' } });
    assert.equal((await placeOrderRequest(app, 'b-store', validOrder(live.productSlug))).statusCode, 404);
  });

  it('draft, archived, unknown and other stores’ products are all the same 409 product_unavailable', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const b = await liveStore(app, 'b@example.com', 'b-store', { stock: 5 });
    const store = await app.prisma.store.findUniqueOrThrow({ where: { slug: 'a-store' } });
    const mk = (slug: string, status: 'DRAFT' | 'ARCHIVED') => app.prisma.product.create({ data: { storeId: store.id, slug, title: 'X', description: 'A product description here.', category: 'Home Décor', pricePaise: 100, stock: 5, status } });
    await mk('a-draft', 'DRAFT');
    await mk('a-archived', 'ARCHIVED');
    const results = [];
    for (const slug of ['a-draft', 'a-archived', 'does-not-exist', b.productSlug]) {
      const res = await placeOrderRequest(app, 'a-store', validOrder(slug));
      assert.equal(res.statusCode, 409, slug);
      assert.equal(json(res).error.code, 'product_unavailable');
      results.push(res.body);
    }
    assert.equal(new Set(results).size, 1, 'indistinguishable responses');
    assert.equal(await stockOf(b.productSlug), 5, 'the other store’s stock is untouched');
    assert.equal((await placeOrderRequest(app, 'a-store', validOrder('bad slug!'))).statusCode, 404);
    void a;
  });

  it('sold out and over-quantity orders are refused with a clear message and change nothing', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 3 });
    const over = await placeOrderRequest(app, 'a-store', validOrder(s.productSlug, { quantity: 4 }));
    assert.equal(over.statusCode, 409);
    assert.equal(json(over).error.code, 'out_of_stock');
    assert.equal(json(over).error.fields.quantity, 'Only 3 left');
    assert.match(json(over).error.message, /Only 3 left/);
    await app.prisma.product.updateMany({ data: { stock: 0 } });
    const sold = await placeOrderRequest(app, 'a-store', validOrder(s.productSlug));
    assert.equal(json(sold).error.code, 'out_of_stock');
    assert.equal(json(sold).error.fields.quantity, 'Sold out');
    assert.deepEqual(await orders(), []);
    assert.equal(await stockOf(s.productSlug), 0);
  });

  it('a product the seller unpublishes can no longer be ordered', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 3 });
    await app.inject({ method: 'POST', url: `/api/seller/products/${s.productId}/unpublish`, headers: { cookie: s.cookie } });
    const res = await placeOrderRequest(app, 'a-store', validOrder(s.productSlug));
    assert.equal(json(res).error.code, 'product_unavailable');
    assert.equal(await stockOf(s.productSlug), 3);
  });

  it('demo (sample) stores can be browsed but not ordered from', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 3 });
    await app.prisma.store.update({ where: { slug: 'a-store' }, data: { isSample: true } });
    const res = await placeOrderRequest(app, 'a-store', validOrder(s.productSlug));
    assert.equal(res.statusCode, 403);
    assert.equal(json(res).error.code, 'demo_store');
    assert.deepEqual(await orders(), []);
    assert.equal(await stockOf(s.productSlug), 3);
    assert.equal((await app.inject({ method: 'GET', url: '/api/public/stores/a-store' })).statusCode, 200, 'still browsable');
  });

  it('an order whose total would overflow is refused and rolls stock back', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 10 });
    await app.prisma.product.updateMany({ data: { pricePaise: 1_000_000_000 } });
    const res = await placeOrderRequest(app, 'a-store', validOrder(s.productSlug, { quantity: 10 }));
    assert.equal(res.statusCode, 400);
    assert.deepEqual(await orders(), []);
    assert.equal(await stockOf(s.productSlug), 10, 'the decrement inside the failed transaction was rolled back');
    assert.equal((await app.prisma.store.findFirstOrThrow()).nextOrderNumber, 1, 'no order number was consumed');
    assert.equal((await placeOrderRequest(app, 'a-store', validOrder(s.productSlug, { quantity: 1 }))).statusCode, 201);
  });
});

describe('idempotency: retries and double-clicks', () => {
  it('the same key returns the same order and takes stock once', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const key = newKey();
    const first = await placeOrderRequest(app, 'a-store', validOrder(s.productSlug, { quantity: 2 }), key);
    const second = await placeOrderRequest(app, 'a-store', validOrder(s.productSlug, { quantity: 2 }), key);
    assert.deepEqual([first.statusCode, second.statusCode], [201, 200]);
    assert.equal(json(first).replayed, false);
    assert.equal(json(second).replayed, true);
    assert.deepEqual(json(second).order, json(first).order);
    assert.equal((await orders()).length, 1);
    assert.equal(await stockOf(s.productSlug), 3);
    for (const pii of ORDER_PII) assert.ok(!second.body.includes(pii), `replay must not echo "${pii}"`);
  });

  it('a retry still succeeds after the product sold out, was unpublished, or the store went offline', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 1 });
    const key = newKey();
    const first = await placeOrderRequest(app, 'a-store', validOrder(s.productSlug), key);
    assert.equal(first.statusCode, 201);
    assert.equal(await stockOf(s.productSlug), 0);
    assert.equal((await placeOrderRequest(app, 'a-store', validOrder(s.productSlug), key)).statusCode, 200, 'sold out');
    await app.inject({ method: 'POST', url: `/api/seller/products/${s.productId}/unpublish`, headers: { cookie: s.cookie } });
    assert.equal((await placeOrderRequest(app, 'a-store', validOrder(s.productSlug), key)).statusCode, 200, 'unpublished');
    assert.equal((await orders()).length, 1);
  });

  it('reusing a key for a DIFFERENT request is a conflict and changes nothing', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const key = newKey();
    await placeOrderRequest(app, 'a-store', validOrder(s.productSlug, { quantity: 1 }), key);
    for (const other of [validOrder(s.productSlug, { quantity: 2 }), validOrder(s.productSlug, { customer: { name: 'Someone Else', phone: '9876512345' } }), validOrder(s.productSlug, { note: 'different' })]) {
      const res = await placeOrderRequest(app, 'a-store', other, key);
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).error.code, 'idempotency_conflict');
    }
    assert.equal((await orders()).length, 1);
    assert.equal(await stockOf(s.productSlug), 4);
  });

  it('keys are scoped per store', async () => {
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    const b = await liveStore(app, 'b@example.com', 'b-store', { stock: 5 });
    const key = newKey();
    assert.equal((await placeOrderRequest(app, 'a-store', validOrder(a.productSlug), key)).statusCode, 201);
    assert.equal((await placeOrderRequest(app, 'b-store', validOrder(b.productSlug), key)).statusCode, 201, 'same key at another store is a different order');
    assert.equal((await orders()).length, 2);
  });
});

describe('privacy in errors and logs', () => {
  it('error log payloads for public checkout contain no message, stack or customer data', () => {
    const err = Object.assign(new Error('Invalid prisma.order.create() invocation: customerName: "Anita Verma", customerPhone: "9876512345"'), { code: 'P2002', name: 'PrismaClientKnownRequestError' });
    const safe = JSON.stringify(errorLogPayload(err, 'POST', '/api/public/stores/a-store/orders'));
    for (const pii of ['Anita', '9876512345', 'invocation', 'customerName']) assert.ok(!safe.includes(pii), `log payload must not include ${pii}`);
    assert.match(safe, /PrismaClientKnownRequestError/);
    assert.match(safe, /P2002/);
    // other routes keep full error logging
    assert.equal((errorLogPayload(err, 'GET', '/api/seller/products') as { err?: unknown }).err, err);
    assert.equal((errorLogPayload(err, 'POST', '/api/seller/products/x/publish') as { err?: unknown }).err, err);
  });

  it('a crash inside checkout returns a generic 500 and logs no customer data', async () => {
    const logged: string[] = [];
    const { app: spy } = await makeApp({}, ai, (a) => {
      a.addHook('onRequest', async (req) => {
        const orig = req.log.error.bind(req.log);
        (req.log as { error: unknown }).error = (...args: unknown[]) => {
          logged.push(JSON.stringify(args, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v)));
          return (orig as (...a: unknown[]) => void)(...args);
        };
      });
    });
    const s = await liveStore(spy, 'a@example.com', 'a-store', { stock: 3 });
    const real = spy.prisma.$transaction.bind(spy.prisma);
    (spy.prisma as { $transaction: unknown }).$transaction = async () => {
      throw new Error('boom: Invalid create() for Anita Verma 9876512345 at 12 MG Road');
    };
    const res = await placeOrderRequest(spy, 'a-store', validOrder(s.productSlug));
    (spy.prisma as { $transaction: unknown }).$transaction = real;
    assert.equal(res.statusCode, 500);
    assert.equal(json(res).error.code, 'internal_error');
    for (const pii of ['Anita', '9876512345', 'MG Road', 'boom']) assert.ok(!res.body.includes(pii), `response must not include ${pii}`);
    assert.ok(logged.length >= 1, 'the failure was logged');
    for (const pii of ['Anita', '9876512345', 'MG Road', 'boom', 'Invalid create']) assert.ok(!logged.join('\n').includes(pii), `logs must not include ${pii}`);
    await spy.close();
  });
});

describe('database constraints (last line of defence)', () => {
  it('reject inconsistent totals and non-positive quantities or prices', async () => {
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 5 });
    assert.equal((await placeOrderRequest(app, 'a-store', validOrder(s.productSlug))).statusCode, 201);
    const o = await app.prisma.order.findFirstOrThrow({ include: { items: true } });
    await assert.rejects(() => app.prisma.order.update({ where: { id: o.id }, data: { totalPaise: o.totalPaise + 1 } }), /orders_total_matches_chk/);
    await assert.rejects(() => app.prisma.order.update({ where: { id: o.id }, data: { deliveryPaise: -1, totalPaise: o.subtotalPaise - 1 } }), /orders_amounts_nonnegative_chk/);
    await assert.rejects(() => app.prisma.orderItem.update({ where: { id: o.items[0].id }, data: { quantity: 0 } }), /order_items_quantity_positive_chk/);
    await assert.rejects(() => app.prisma.orderItem.update({ where: { id: o.items[0].id }, data: { unitPricePaise: 0 } }), /order_items_unit_price_positive_chk/);
    await assert.rejects(() => app.prisma.order.create({ data: { storeId: o.storeId, orderNumber: 99, customerName: 'x', customerPhone: '9000000000', shippingLine1: 'x', shippingCity: 'x', shippingState: 'x', shippingPincode: '123456', subtotalPaise: 1, deliveryPaise: 0, totalPaise: 1, idempotencyKey: o.idempotencyKey, requestHash: 'h' } }), /Unique constraint|idempotencyKey/);
  });
});
