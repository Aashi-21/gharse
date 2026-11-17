import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { inspectImage } from '../src/lib/imageInfo';
import { slugify } from '../src/lib/slug';
import { jpegBytes, pngBytes, webpBytes } from './images';
import { makeApp, resetDb, sellerWithStore } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);
let app: FastifyInstance;
before(async () => ({ app } = await makeApp()));
after(async () => app.close());
beforeEach(resetDb);

async function makeProduct(cookie: string, over: Record<string, unknown> = {}, image = jpegBytes()) {
  const store = await app.prisma.store.findFirstOrThrow({ where: { sellerProfile: { user: { sessions: { some: { tokenHash: { not: '' } } } } } } });
  void store;
  const me = json(await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } }));
  const key = `products/${me.store.id}/test-${Math.random().toString(36).slice(2)}.jpg`;
  await app.storage.put(key, image);
  return app.prisma.product.create({
    data: {
      storeId: me.store.id, slug: `p-${Math.random().toString(36).slice(2)}`, title: 'Draft candle', description: 'Soft glow.',
      category: 'Candles & Home Fragrance', tags: ['candle'], brandVersion: 1,
      images: { create: { storageKey: key, mimeType: 'image/jpeg', sizeBytes: image.length } },
      ...over,
    },
  });
}

describe('inspectImage (real byte layouts)', () => {
  it('identifies JPEG, PNG and WebP and reads their dimensions', () => {
    assert.deepEqual(inspectImage(jpegBytes(1568, 1024)), { mime: 'image/jpeg', ext: 'jpg', width: 1568, height: 1024 });
    assert.deepEqual(inspectImage(jpegBytes(300, 200, 10, 0xc2)), { mime: 'image/jpeg', ext: 'jpg', width: 300, height: 200 }); // progressive
    assert.deepEqual(inspectImage(pngBytes(800, 600)), { mime: 'image/png', ext: 'png', width: 800, height: 600 });
    for (const k of ['VP8X', 'VP8L', 'VP8 '] as const) {
      assert.deepEqual(inspectImage(webpBytes(k, 1000, 750)), { mime: 'image/webp', ext: 'webp', width: 1000, height: 750 }, k);
    }
  });
  it('rejects everything else, regardless of what the file claims to be', () => {
    const cases: [string, Buffer][] = [
      ['plain text', Buffer.from('hello this is not an image'.repeat(5))],
      ['html', Buffer.from('<html><script>alert(1)</script></html>'.repeat(3))],
      ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"></svg>')],
      ['gif', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(40)])],
      ['pdf', Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(40)])],
      ['empty', Buffer.alloc(0)],
      ['truncated png', pngBytes().subarray(0, 12)],
      ['truncated jpeg', jpegBytes().subarray(0, 6)],
      ['riff but not webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(40)])],
      ['jpeg without frame header', Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0])],
    ];
    for (const [name, buf] of cases) assert.equal(inspectImage(buf), null, name);
  });
});

describe('slugify', () => {
  it('makes safe ascii slugs', () => {
    assert.equal(slugify('Hand-painted Diya Set!'), 'hand-painted-diya-set');
    assert.equal(slugify('Crème brûlée ../../etc'), 'creme-brulee-etc');
    assert.equal(slugify('!!!'), 'product');
  });
});

describe('products: list / get / image / edit', () => {
  it('require authentication', async () => {
    for (const [method, url] of [['GET', '/api/seller/products'], ['GET', '/api/seller/products/x'], ['PATCH', '/api/seller/products/x'], ['GET', '/api/seller/products/x/image']] as const) {
      assert.equal((await app.inject({ method, url })).statusCode, 401, url);
    }
  });

  it('isolates sellers: other sellers cannot list, read, edit or fetch the image', async () => {
    const a = await sellerWithStore(app, 'a@example.com', 'a-store');
    const b = await sellerWithStore(app, 'b@example.com', 'b-store');
    const pa = await makeProduct(a, { title: 'A secret draft' });

    assert.equal(json(await app.inject({ method: 'GET', url: '/api/seller/products', headers: { cookie: b } })).products.length, 0);
    assert.equal(json(await app.inject({ method: 'GET', url: '/api/seller/products', headers: { cookie: a } })).products.length, 1);
    assert.equal((await app.inject({ method: 'GET', url: `/api/seller/products/${pa.id}`, headers: { cookie: b } })).statusCode, 404);
    const patch = await app.inject({ method: 'PATCH', url: `/api/seller/products/${pa.id}`, headers: { cookie: b }, payload: { title: 'Hijacked' } });
    assert.equal(patch.statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: `/api/seller/products/${pa.id}/image`, headers: { cookie: b } })).statusCode, 404);
    assert.equal((await app.prisma.product.findUniqueOrThrow({ where: { id: pa.id } })).title, 'A secret draft');
  });

  it('serves the owner their image with the stored content type and bytes', async () => {
    const a = await sellerWithStore(app, 'a@example.com', 'a-store');
    const img = jpegBytes(900, 700, 200);
    const p = await makeProduct(a, {}, img);
    const res = await app.inject({ method: 'GET', url: `/api/seller/products/${p.id}/image`, headers: { cookie: a } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/jpeg');
    assert.ok(res.rawPayload.equals(img));
  });

  it('never leaks storage keys or the raw AI draft to the browser', async () => {
    const a = await sellerWithStore(app, 'a@example.com', 'a-store');
    const p = await makeProduct(a, { aiDraft: { secret: 'x' } });
    const res = await app.inject({ method: 'GET', url: `/api/seller/products/${p.id}`, headers: { cookie: a } });
    assert.ok(!res.body.includes('storageKey') && !/products\/[^/"]+\/test-/.test(res.body) && !res.body.includes('aiDraft'));
    assert.equal(json(res).product.imageUrl, `/api/seller/products/${p.id}/image`);
  });

  it('persists seller edits (title, description, category, tags, price, stock)', async () => {
    const a = await sellerWithStore(app, 'a@example.com', 'a-store');
    const p = await makeProduct(a);
    const res = await app.inject({
      method: 'PATCH', url: `/api/seller/products/${p.id}`, headers: { cookie: a },
      payload: { title: 'Evening glow candle', description: 'A candle in a glass jar.', category: 'Home Décor', tags: ['Candle', 'candle', ' Gift '], price: '499.50', stock: 12 },
    });
    assert.equal(res.statusCode, 200);
    const row = await app.prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    assert.deepEqual(
      { t: row.title, d: row.description, c: row.category, tags: row.tags, price: row.pricePaise, stock: row.stock, status: row.status },
      { t: 'Evening glow candle', d: 'A candle in a glass jar.', c: 'Home Décor', tags: ['candle', 'gift'], price: 49950, stock: 12, status: 'DRAFT' },
    );
  });

  it('parses INR prices exactly and rejects bad ones', async () => {
    const a = await sellerWithStore(app, 'a@example.com', 'a-store');
    const p = await makeProduct(a);
    const patch = (price: unknown) => app.inject({ method: 'PATCH', url: `/api/seller/products/${p.id}`, headers: { cookie: a }, payload: { price } });
    const good: [unknown, number | null][] = [['499', 49900], [499, 49900], ['0.29', 29], ['19.99', 1999], ['₹ 250', 25000], ['', null], [null, null]];
    for (const [input, paise] of good) {
      const res = await patch(input);
      assert.equal(res.statusCode, 200, String(input));
      assert.equal(json(res).product.pricePaise, paise, String(input));
    }
    for (const bad of ['abc', '0', '-5', '1.234', '1e3', '999999999', true]) {
      assert.equal((await patch(bad)).statusCode, 400, String(bad));
    }
  });

  it('validates the other editable fields and ignores fields the client may not set', async () => {
    const a = await sellerWithStore(app, 'a@example.com', 'a-store');
    const p = await makeProduct(a);
    const bad = await app.inject({ method: 'PATCH', url: `/api/seller/products/${p.id}`, headers: { cookie: a }, payload: { title: 'x', category: 'Weapons', stock: -1, tags: Array(11).fill('t').map((t, i) => t + i) } });
    assert.equal(bad.statusCode, 400);
    assert.ok(Object.keys(json(bad).error.fields).length >= 4);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/seller/products/${p.id}`, headers: { cookie: a }, payload: { stock: 1.5 } })).statusCode, 400);

    await app.inject({ method: 'PATCH', url: `/api/seller/products/${p.id}`, headers: { cookie: a }, payload: { status: 'PUBLISHED', brandVersion: 99, aiDraft: {}, storeId: 'other', pricePaise: 1 } });
    const row = await app.prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    assert.equal(row.status, 'DRAFT');
    assert.equal(row.brandVersion, 1);
    assert.equal(row.pricePaise, null);
  });
});
