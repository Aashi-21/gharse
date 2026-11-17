import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { jpegBytes } from './images';
import { approveBrand, candleListing, cannedBrand, fakeAi, makeApp, resetDb, sellerWithPublishedProduct, validProfile, validStoreSettings } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);
let app: FastifyInstance;
let uploadDir: string;
const ai = fakeAi(() => candleListing);
before(async () => ({ app, uploadDir } = await makeApp({}, ai)));
after(async () => app.close());
beforeEach(resetDb);

const get = (url: string) => app.inject({ method: 'GET', url });
const storeUrl = (slug: string) => `/api/public/stores/${slug}`;

/** A seller with an approved brand, one published product, settings filled in, and the STORE published. */
async function liveStore(email = 'a@example.com', slug = 'a-store', opts: { stock?: number; price?: string } = {}) {
  const s = await sellerWithPublishedProduct(app, email, slug, opts);
  const put = await app.inject({ method: 'PUT', url: '/api/seller/store/settings', headers: { cookie: s.cookie }, payload: validStoreSettings });
  assert.equal(put.statusCode, 200, put.body);
  const pub = await app.inject({ method: 'POST', url: '/api/seller/store/publish', headers: { cookie: s.cookie } });
  assert.equal(pub.statusCode, 200, pub.body);
  const image = await app.prisma.productImage.findFirstOrThrow({ where: { productId: s.productId } });
  return { ...s, file: path.join(uploadDir, image.storageKey) };
}
const extraProduct = (storeSlug: string, over: Record<string, unknown>) =>
  app.prisma.store.findUniqueOrThrow({ where: { slug: storeSlug } }).then((st) =>
    app.prisma.product.create({ data: { storeId: st.id, slug: `p-${Math.random().toString(36).slice(2)}`, title: 'Extra candle', description: 'An extra candle in a clear glass jar.', category: 'Home Décor', pricePaise: 29900, stock: 3, ...over } as never }),
  );

describe('store visibility', () => {
  it('an unpublished store is a plain 404 on every public route, identical to a store that does not exist', async () => {
    const s = await sellerWithPublishedProduct(app, 'a@example.com', 'a-store'); // store NOT published
    const urls = [storeUrl('a-store'), `${storeUrl('a-store')}/products/${s.productSlug}`, `${storeUrl('a-store')}/products/${s.productSlug}/image`];
    const nothing = await get(storeUrl('does-not-exist'));
    for (const u of urls) {
      const res = await get(u);
      assert.equal(res.statusCode, 404, u);
      assert.equal(res.body, nothing.body, 'same body as a store that does not exist');
    }
  });

  it('becomes visible when published and disappears immediately when taken offline', async () => {
    const s = await liveStore();
    assert.equal((await get(storeUrl('a-store'))).statusCode, 200);
    await app.inject({ method: 'POST', url: '/api/seller/store/unpublish', headers: { cookie: s.cookie } });
    assert.equal((await get(storeUrl('a-store'))).statusCode, 404);
    assert.equal((await get(`${storeUrl('a-store')}/products/${s.productSlug}/image`)).statusCode, 404);
  });

  it('needs an approved brand, and reads the brand fresh from the database', async () => {
    const s = await liveStore();
    const body = json(await get(storeUrl('a-store')));
    assert.deepEqual(
      { name: body.store.name, tagline: body.store.tagline, primary: body.store.primaryColor, secondary: body.store.secondaryColor },
      { name: cannedBrand.name, tagline: cannedBrand.tagline, primary: '#8A4B2D', secondary: '#E9C46A' },
    );
    await approveBrand(app, s.cookie, { name: 'Renamed Brand', primaryColor: '#112233' });
    const after = json(await get(storeUrl('a-store')));
    assert.deepEqual([after.store.name, after.store.primaryColor], ['Renamed Brand', '#112233']);
    await app.prisma.brandProfile.updateMany({ data: { status: 'DRAFT' } });
    assert.equal((await get(storeUrl('a-store'))).statusCode, 404);
  });

  it('lookup is case-insensitive on the slug but never matches partial or odd slugs', async () => {
    await liveStore();
    assert.equal((await get(storeUrl('A-Store'))).statusCode, 200);
    for (const bad of ['a-stor', 'a-store%2F..', '..', '%00', 'a%00b', 'a store', '-a-store', 'a--store']) assert.equal((await get(storeUrl(bad))).statusCode, 404, bad.slice(0, 20));
    const huge = (await get(storeUrl('x'.repeat(5000)))).statusCode;
    assert.ok(huge === 404 || huge === 414, `absurdly long slug must be refused (got ${huge})`);
    const s = await app.prisma.store.findFirstOrThrow();
    assert.equal(s.slug, 'a-store');
    for (const bad of ['%00', 'a%00', '..%2f..', 'UPPER_case']) {
      assert.equal((await get(`${storeUrl('a-store')}/products/${bad}`)).statusCode, 404, `product ${bad}`);
      assert.equal((await get(`${storeUrl('a-store')}/products/${bad}/image`)).statusCode, 404, `image ${bad}`);
    }
    const hugeProduct = (await get(`${storeUrl('a-store')}/products/${'x'.repeat(5000)}`)).statusCode;
    assert.ok(hugeProduct === 404 || hugeProduct === 414, `absurdly long product slug must be refused (got ${hugeProduct})`);
  });
});

describe('products shown to customers', () => {
  it('shows ONLY published products (drafts and archived never appear), newest first, sold-out ones included', async () => {
    const s = await liveStore('a@example.com', 'a-store', { stock: 5 });
    await extraProduct('a-store', { title: 'A draft', slug: 'a-draft' });
    await extraProduct('a-store', { title: 'Archived one', slug: 'archived-one', status: 'ARCHIVED' });
    await extraProduct('a-store', { title: 'Sold out candle', slug: 'sold-out', status: 'PUBLISHED', publishedAt: new Date(Date.now() + 1000), stock: 0 });
    const body = json(await get(storeUrl('a-store')));
    assert.deepEqual(body.products.map((p: { title: string }) => p.title), ['Sold out candle', candleListing.title]);
    const soldOut = body.products[0];
    assert.deepEqual({ inStock: soldOut.inStock, max: soldOut.maxQuantity }, { inStock: false, max: 0 });
    assert.deepEqual({ inStock: body.products[1].inStock, max: body.products[1].maxQuantity }, { inStock: true, max: 5 });
    void s;
  });

  it('caps the orderable quantity and never exposes the exact stock', async () => {
    await liveStore('a@example.com', 'a-store', { stock: 250 });
    const p = json(await get(storeUrl('a-store'))).products[0];
    assert.equal(p.maxQuantity, 10);
    assert.ok(!('stock' in p), 'no exact stock field');
    assert.ok(!JSON.stringify(p).includes('250'), 'the real stock number is not leaked');
  });

  it('product detail works for live products and is a uniform 404 for drafts, archived, unknown and other stores’ products', async () => {
    const a = await liveStore('a@example.com', 'a-store');
    const b = await liveStore('b@example.com', 'b-store');
    const draft = await extraProduct('a-store', { slug: 'a-draft' });
    const archived = await extraProduct('a-store', { slug: 'a-archived', status: 'ARCHIVED' });
    const ok = await get(`${storeUrl('a-store')}/products/${a.productSlug}`);
    assert.equal(ok.statusCode, 200);
    assert.equal(json(ok).product.title, candleListing.title);
    const gone = (await get(`${storeUrl('a-store')}/products/nope`)).body;
    for (const slug of [draft.slug, archived.slug, 'nope', b.productSlug]) {
      const res = await get(`${storeUrl('a-store')}/products/${slug}`);
      assert.equal(res.statusCode, 404, slug);
      assert.equal(res.body, gone, 'identical body: drafts cannot be told apart from nothing');
    }
  });

  it('a product unpublished by the seller vanishes from the store, detail and image immediately', async () => {
    const s = await liveStore();
    await app.inject({ method: 'POST', url: `/api/seller/products/${s.productId}/unpublish`, headers: { cookie: s.cookie } });
    assert.equal(json(await get(storeUrl('a-store'))).products.length, 0);
    assert.equal((await get(`${storeUrl('a-store')}/products/${s.productSlug}`)).statusCode, 404);
    assert.equal((await get(`${storeUrl('a-store')}/products/${s.productSlug}/image`)).statusCode, 404);
  });
});

describe('privacy: what the public API exposes', () => {
  it('returns only whitelisted fields (no ids, seller details, internals)', async () => {
    const s = await liveStore();
    const res = await get(`${storeUrl('a-store')}/products/${s.productSlug}`);
    const body = json(res);
    assert.deepEqual(Object.keys(body.store).sort(), ['checkoutEnabled', 'contactPhone', 'deliveryChargePaise', 'deliveryPolicy', 'isSample', 'name', 'primaryColor', 'returnPolicy', 'secondaryColor', 'slug', 'story', 'tagline']);
    assert.deepEqual(Object.keys(body.product).sort(), ['category', 'description', 'imageUrl', 'inStock', 'maxQuantity', 'pricePaise', 'slug', 'tags', 'title']);
    const store = await app.prisma.store.findFirstOrThrow();
    const user = await app.prisma.user.findFirstOrThrow();
    const profile = await app.prisma.sellerProfile.findFirstOrThrow();
    const image = await app.prisma.productImage.findFirstOrThrow();
    for (const secret of [store.id, user.id, user.email, profile.id, profile.fullName, s.productId, image.storageKey, image.id, 'aiDraft', 'sellerNotes', 'storageKey', 'passwordHash', uploadDir]) {
      assert.ok(!res.body.includes(secret), `public response must not contain ${secret}`);
    }
  });

  it('shows the contact phone only if the seller entered it, and never the private profile phone', async () => {
    const s = await liveStore();
    const body = json(await get(storeUrl('a-store')));
    assert.equal(body.store.contactPhone, '9811122233');
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes(validProfile.phone.replace(/\D/g, '').slice(-10)) || validProfile.phone.replace(/\D/g, '').slice(-10) === '9811122233', 'profile phone is not exposed');
    // the live store must keep a phone, so check the unset case on a sample-like store directly
    await app.prisma.store.update({ where: { slug: 'a-store' }, data: { contactPhone: null } });
    assert.equal(json(await get(storeUrl('a-store'))).store.contactPhone, null);
    void s;
  });

  it('marks demo stores and disables checkout for them', async () => {
    await liveStore();
    assert.deepEqual([json(await get(storeUrl('a-store'))).store.isSample, json(await get(storeUrl('a-store'))).store.checkoutEnabled], [false, true]);
    await app.prisma.store.update({ where: { slug: 'a-store' }, data: { isSample: true } });
    const demo = json(await get(storeUrl('a-store')));
    assert.deepEqual([demo.store.isSample, demo.store.checkoutEnabled], [true, false]);
  });

  it('is never cached by browsers or proxies (stock changes constantly)', async () => {
    await liveStore();
    assert.equal((await get(storeUrl('a-store'))).headers['cache-control'], 'no-store');
  });
});

describe('product images', () => {
  it('serves the real bytes with the right type and a short public cache', async () => {
    const s = await liveStore();
    const res = await get(`${storeUrl('a-store')}/products/${s.productSlug}/image`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/jpeg');
    assert.equal(res.headers['cache-control'], 'public, max-age=300');
    assert.ok(res.rawPayload.equals(fs.readFileSync(s.file)));
    assert.equal(json(await get(storeUrl('a-store'))).products[0].imageUrl, `${storeUrl('a-store')}/products/${s.productSlug}/image`);
  });

  it('a missing or unreadable file is a safe 404 with no paths or errors', async () => {
    const s = await liveStore();
    fs.unlinkSync(s.file);
    const res = await get(`${storeUrl('a-store')}/products/${s.productSlug}/image`);
    assert.equal(res.statusCode, 404);
    for (const leak of [uploadDir, 'ENOENT', 'products/', '/tmp', 'storageKey']) assert.ok(!res.body.includes(leak), `no "${leak}" in the 404`);
    assert.equal((await get(`${storeUrl('a-store')}/products/${s.productSlug}`)).statusCode, 200, 'the product page itself still loads');
    // directory instead of file, and an inaccessible folder: still just a 404
    fs.mkdirSync(s.file);
    assert.equal((await get(`${storeUrl('a-store')}/products/${s.productSlug}/image`)).statusCode, 404);
    fs.rmdirSync(s.file);
    fs.writeFileSync(s.file, jpegBytes(800, 600, 100));
    const dir = path.dirname(s.file);
    fs.chmodSync(dir, 0o000);
    try {
      assert.equal((await get(`${storeUrl('a-store')}/products/${s.productSlug}/image`)).statusCode, 404);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });

  it('a product without any photo has no imageUrl, and its image route is a 404', async () => {
    await liveStore();
    const p = await extraProduct('a-store', { slug: 'no-photo', status: 'PUBLISHED', publishedAt: new Date() });
    const body = json(await get(storeUrl('a-store')));
    assert.equal(body.products.find((x: { slug: string }) => x.slug === p.slug).imageUrl, null);
    assert.equal((await get(`${storeUrl('a-store')}/products/${p.slug}/image`)).statusCode, 404);
  });

  it('image of a draft product, or of another store, is not reachable through this store', async () => {
    const a = await liveStore('a@example.com', 'a-store');
    const b = await liveStore('b@example.com', 'b-store');
    const img = await app.prisma.productImage.create({ data: { productId: (await extraProduct('a-store', { slug: 'draft-with-photo' })).id, storageKey: a.file.replace(uploadDir + path.sep, ''), mimeType: 'image/jpeg', sizeBytes: 1 } });
    assert.ok(img.id);
    assert.equal((await get(`${storeUrl('a-store')}/products/draft-with-photo/image`)).statusCode, 404);
    assert.equal((await get(`${storeUrl('b-store')}/products/${a.productSlug}/image`)).statusCode, 404);
    void b;
  });
});
