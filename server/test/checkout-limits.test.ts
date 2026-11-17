import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { candleListing, fakeAi, liveStore, makeApp, newKey, placeOrderRequest, resetDb, validOrder } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);
const ai = fakeAi(() => candleListing);
const phone = (i: number) => `9${String(100000000 + i)}`;
const buyer = (slug: string, i: number, p?: string) => validOrder(slug, { customer: { name: `Buyer ${i}`, phone: p ?? phone(i) } });

let apps: FastifyInstance[] = [];
async function appWith(overrides: Record<string, string>) {
  const { app } = await makeApp(overrides, ai);
  apps.push(app);
  return app;
}
before(resetDb);
beforeEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
  await resetDb();
});
after(async () => {
  for (const a of apps) await a.close();
});

describe('per-phone limit', () => {
  it('allows 3 orders per phone number per store per hour, then refuses with 429 and changes nothing', async () => {
    const app = await appWith({ ORDER_PHONE_HOURLY_LIMIT: '3' });
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 10 });
    for (let i = 0; i < 3; i++) assert.equal((await placeOrderRequest(app, 'a-store', buyer(s.productSlug, i, '9876512345'))).statusCode, 201, `order ${i + 1}`);
    const fourth = await placeOrderRequest(app, 'a-store', buyer(s.productSlug, 9, '9876512345'));
    assert.equal(fourth.statusCode, 429);
    assert.equal(json(fourth).error.code, 'rate_limited');
    assert.equal((await app.prisma.order.count()), 3);
    assert.equal((await app.prisma.product.findFirstOrThrow()).stock, 7, 'a refused order takes no stock');
    assert.equal((await placeOrderRequest(app, 'a-store', buyer(s.productSlug, 10, '9876500001'))).statusCode, 201, 'a different phone is fine');
  });

  it('formatting tricks do not evade it, and the limit is per store', async () => {
    const app = await appWith({ ORDER_PHONE_HOURLY_LIMIT: '1' });
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 10 });
    const b = await liveStore(app, 'b@example.com', 'b-store', { stock: 10 });
    assert.equal((await placeOrderRequest(app, 'a-store', buyer(a.productSlug, 1, '98765 12345'))).statusCode, 201);
    for (const variant of ['+91 98765-12345', '09876512345', '9876512345']) {
      assert.equal((await placeOrderRequest(app, 'a-store', buyer(a.productSlug, 2, variant))).statusCode, 429, variant);
    }
    assert.equal((await placeOrderRequest(app, 'b-store', buyer(b.productSlug, 3, '9876512345'))).statusCode, 201, 'other store is separate');
  });

  it('orders older than an hour no longer count', async () => {
    const app = await appWith({ ORDER_PHONE_HOURLY_LIMIT: '1' });
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 10 });
    assert.equal((await placeOrderRequest(app, 'a-store', buyer(s.productSlug, 1, '9876512345'))).statusCode, 201);
    assert.equal((await placeOrderRequest(app, 'a-store', buyer(s.productSlug, 2, '9876512345'))).statusCode, 429);
    await app.prisma.order.updateMany({ data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    assert.equal((await placeOrderRequest(app, 'a-store', buyer(s.productSlug, 3, '9876512345'))).statusCode, 201);
  });

  it('a retry of an existing order is never blocked by the phone limit', async () => {
    const app = await appWith({ ORDER_PHONE_HOURLY_LIMIT: '1' });
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 10 });
    const key = newKey();
    assert.equal((await placeOrderRequest(app, 'a-store', buyer(s.productSlug, 1, '9876512345'), key)).statusCode, 201);
    assert.equal((await placeOrderRequest(app, 'a-store', buyer(s.productSlug, 1, '9876512345'), key)).statusCode, 200, 'same key replays');
    assert.equal((await placeOrderRequest(app, 'a-store', buyer(s.productSlug, 1, '9876512345'), newKey())).statusCode, 429, 'a NEW order is blocked');
  });
});

describe('per-store limit', () => {
  it('caps orders per store per hour, without affecting other stores', async () => {
    const app = await appWith({ ORDER_STORE_HOURLY_LIMIT: '2' });
    const a = await liveStore(app, 'a@example.com', 'a-store', { stock: 10 });
    const b = await liveStore(app, 'b@example.com', 'b-store', { stock: 10 });
    for (let i = 0; i < 2; i++) assert.equal((await placeOrderRequest(app, 'a-store', buyer(a.productSlug, i))).statusCode, 201);
    const third = await placeOrderRequest(app, 'a-store', buyer(a.productSlug, 5));
    assert.equal(third.statusCode, 429);
    assert.equal(json(third).error.code, 'store_busy');
    assert.equal((await placeOrderRequest(app, 'b-store', buyer(b.productSlug, 6))).statusCode, 201, 'another store is unaffected');
    assert.equal((await app.prisma.product.findFirst({ where: { slug: a.productSlug } }))!.stock, 8);
  });
});

describe('per-IP limit and the TRUST_PROXY setting', () => {
  const spoof = (app: FastifyInstance, slug: string, productSlug: string, i: number, xff: string) =>
    placeOrderRequest(app, slug, buyer(productSlug, i), newKey(), { 'x-forwarded-for': xff });

  it('limits orders per IP per minute with a clear 429 (and refused requests change nothing)', async () => {
    const app = await appWith({ ORDER_RATE_LIMIT_MAX: '2' });
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 10 });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await placeOrderRequest(app, 'a-store', buyer(s.productSlug, i))).statusCode);
    assert.deepEqual(codes, [201, 201, 429, 429]);
    const refused = await placeOrderRequest(app, 'a-store', buyer(s.productSlug, 9));
    assert.equal(json(refused).error.code, 'rate_limited');
    assert.equal(await app.prisma.order.count(), 2);
    assert.equal((await app.inject({ method: 'GET', url: '/api/public/stores/a-store' })).statusCode, 200, 'browsing the store is not affected');
  });

  it('TRUST_PROXY=false (default): a forged X-Forwarded-For does NOT evade the limit', async () => {
    const app = await appWith({ ORDER_RATE_LIMIT_MAX: '2', TRUST_PROXY: 'false' });
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 10 });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await spoof(app, 'a-store', s.productSlug, i, `203.0.113.${i + 1}`)).statusCode);
    assert.deepEqual(codes, [201, 201, 429, 429], 'every spoofed address was treated as the same real client');
  });

  it('TRUST_PROXY=true: the proxy-provided client IP is used, so different visitors are limited separately', async () => {
    const app = await appWith({ ORDER_RATE_LIMIT_MAX: '2', TRUST_PROXY: 'true' });
    const s = await liveStore(app, 'a@example.com', 'a-store', { stock: 10 });
    const distinct: number[] = [];
    for (let i = 0; i < 4; i++) distinct.push((await spoof(app, 'a-store', s.productSlug, i, `203.0.113.${i + 1}`)).statusCode);
    assert.deepEqual(distinct, [201, 201, 201, 201], 'four different visitors behind the proxy are not lumped together');
    const same: number[] = [];
    for (let i = 10; i < 13; i++) same.push((await spoof(app, 'a-store', s.productSlug, i, '198.51.100.7')).statusCode);
    assert.deepEqual(same, [201, 201, 429], 'but one visitor is still limited');
  });

  it('the default configuration does not trust forwarded headers', async () => {
    const { loadConfig } = await import('../src/config');
    assert.equal(loadConfig({ DATABASE_URL: 'postgresql://a:b@h/db' }).TRUST_PROXY, false);
    assert.equal(loadConfig({ DATABASE_URL: 'postgresql://a:b@h/db' }).ORDER_RATE_LIMIT_MAX, 10);
    assert.equal(loadConfig({ DATABASE_URL: 'postgresql://a:b@h/db' }).ORDER_PHONE_HOURLY_LIMIT, 3);
    assert.equal(loadConfig({ DATABASE_URL: 'postgresql://a:b@h/db' }).ORDER_STORE_HOURLY_LIMIT, 100);
  });
});
