import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { jpegBytes } from './images';
import { analyzeRequest, approveBrand, candleListing, fakeAi, makeApp, register, resetDb, sellerWithPublishedProduct, sellerWithStore, validStoreSettings } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);
let app: FastifyInstance;
const ai = fakeAi(() => candleListing);
before(async () => ({ app } = await makeApp({}, ai)));
after(async () => app.close());
beforeEach(resetDb);

const getSettings = (cookie: string) => app.inject({ method: 'GET', url: '/api/seller/store/settings', headers: { cookie } });
const putSettings = (cookie: string, payload: object) => app.inject({ method: 'PUT', url: '/api/seller/store/settings', headers: { cookie }, payload });
const publishStore = (cookie: string) => app.inject({ method: 'POST', url: '/api/seller/store/publish', headers: { cookie } });
const unpublishStore = (cookie: string) => app.inject({ method: 'POST', url: '/api/seller/store/unpublish', headers: { cookie } });
const storeRow = () => app.prisma.store.findFirstOrThrow();

describe('store settings', () => {
  it('requires authentication, and a store', async () => {
    for (const [method, url] of [['GET', '/api/seller/store/settings'], ['PUT', '/api/seller/store/settings'], ['POST', '/api/seller/store/publish'], ['POST', '/api/seller/store/unpublish']] as const) {
      assert.equal((await app.inject({ method, url, payload: method === 'PUT' ? {} : undefined })).statusCode, 401, url);
    }
    const { cookie } = await register(app, 'nostore@example.com');
    assert.equal((await getSettings(cookie)).statusCode, 409);
  });

  it('never copies the seller’s profile phone into the public contact phone', async () => {
    const cookie = await sellerWithStore(app, 'a@example.com', 'a-store'); // profile phone is set to a real number
    const profile = await app.prisma.sellerProfile.findFirstOrThrow();
    assert.ok(profile.phone, 'the seller has a private profile phone');
    const res = await getSettings(cookie);
    assert.equal(json(res).settings.contactPhone, null);
    assert.equal((await storeRow()).contactPhone, null);
    // ...and saving other settings does not fill it in either
    await putSettings(cookie, { deliveryPolicy: validStoreSettings.deliveryPolicy });
    assert.equal((await storeRow()).contactPhone, null);
  });

  it('saves settings with normalised phone and paise, and omitted fields stay unchanged', async () => {
    const cookie = await sellerWithStore(app, 'a@example.com', 'a-store');
    const res = await putSettings(cookie, validStoreSettings);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res).settings, {
      contactPhone: '9811122233', deliveryPolicy: validStoreSettings.deliveryPolicy, returnPolicy: validStoreSettings.returnPolicy, deliveryChargePaise: 6000,
    });
    await putSettings(cookie, { deliveryCharge: '0' });
    const after = (await storeRow());
    assert.deepEqual({ p: after.contactPhone, c: after.deliveryChargePaise, d: after.deliveryPolicy }, { p: '9811122233', c: 0, d: validStoreSettings.deliveryPolicy });
    await putSettings(cookie, { contactPhone: '', returnPolicy: '  ' });
    const cleared = await storeRow();
    assert.equal(cleared.contactPhone, null);
    assert.equal(cleared.returnPolicy, null);
  });

  it('parses delivery charges exactly and validates everything on the backend', async () => {
    const cookie = await sellerWithStore(app, 'a@example.com', 'a-store');
    for (const [input, paise] of [['60', 6000], [60, 6000], ['₹ 45.50', 4550], ['0', 0], ['', 0], ['9999.99', 999999]] as const) {
      const res = await putSettings(cookie, { deliveryCharge: input });
      assert.equal(res.statusCode, 200, String(input));
      assert.equal(json(res).settings.deliveryChargePaise, paise, String(input));
    }
    for (const bad of ['abc', '-5', '1.234', '10000.01', '1e3', '100000']) {
      assert.equal((await putSettings(cookie, { deliveryCharge: bad })).statusCode, 400, `charge ${bad}`);
    }
    const phone = await putSettings(cookie, { contactPhone: '12345' });
    assert.equal(phone.statusCode, 400);
    assert.ok(json(phone).error.fields.contactPhone);
    assert.equal((await putSettings(cookie, { deliveryPolicy: 'x'.repeat(1001) })).statusCode, 400);
  });
});

describe('store publishing', () => {
  it('lists every missing requirement, and publishing is refused until all are met', async () => {
    const cookie = await sellerWithStore(app, 'a@example.com', 'a-store');
    const res = await publishStore(cookie);
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error.code, 'store_not_publishable');
    assert.deepEqual(Object.keys(json(res).error.fields).sort(), ['brand', 'contactPhone', 'deliveryPolicy', 'products', 'returnPolicy']);
    assert.equal((await storeRow()).isPublished, false);
    const view = json(await getSettings(cookie));
    assert.equal(view.readiness.canPublish, false);
    assert.equal(view.readiness.issues.length, 5);
  });

  it('each requirement is enforced on its own', async () => {
    const { cookie } = await sellerWithPublishedProduct(app, 'a@example.com', 'a-store');
    const store = await storeRow();
    await putSettings(cookie, validStoreSettings);
    const cases: [string, object, string][] = [
      ['no phone', { contactPhone: null }, 'contactPhone'],
      ['no delivery policy', { deliveryPolicy: null }, 'deliveryPolicy'],
      ['no return policy', { returnPolicy: null }, 'returnPolicy'],
    ];
    for (const [name, change, field] of cases) {
      await app.prisma.store.update({ where: { id: store.id }, data: change });
      const res = await publishStore(cookie);
      assert.equal(res.statusCode, 400, name);
      assert.deepEqual(Object.keys(json(res).error.fields), [field], name);
      await putSettings(cookie, validStoreSettings);
    }
    await app.prisma.store.update({ where: { id: store.id }, data: { deliveryPolicy: 'short' } });
    assert.deepEqual(Object.keys(json(await publishStore(cookie)).error.fields), ['deliveryPolicy'], 'too-short policy');
    await putSettings(cookie, validStoreSettings);
    assert.equal((await publishStore(cookie)).statusCode, 200);
  });

  it('needs an approved brand', async () => {
    const cookie = await sellerWithStore(app, 'a@example.com', 'a-store');
    const store = await storeRow();
    await app.prisma.product.create({ data: { storeId: store.id, slug: 'p', title: 'Candle', description: 'A calm candle in a glass jar.', category: 'Home Décor', pricePaise: 100, stock: 1, status: 'PUBLISHED', publishedAt: new Date() } });
    await putSettings(cookie, validStoreSettings);
    const res = await publishStore(cookie);
    assert.deepEqual(Object.keys(json(res).error.fields), ['brand']);
  });

  it('needs at least one PUBLISHED product: drafts and archived products do not count', async () => {
    const cookie = await sellerWithStore(app, 'a@example.com', 'a-store');
    await approveBrand(app, cookie);
    await putSettings(cookie, validStoreSettings);
    const draft = await analyzeRequest(app, cookie, jpegBytes(800, 600, 200));
    assert.equal(draft.statusCode, 201);
    assert.deepEqual(Object.keys(json(await publishStore(cookie)).error.fields), ['products'], 'a draft is not enough');
    const store = await storeRow();
    await app.prisma.product.create({ data: { storeId: store.id, slug: 'old', title: 'Old', description: 'An archived candle in a jar.', category: 'Home Décor', pricePaise: 100, stock: 1, status: 'ARCHIVED' } });
    assert.deepEqual(Object.keys(json(await publishStore(cookie)).error.fields), ['products'], 'archived is not enough');
  });

  it('publishes, is idempotent, and can be unpublished and republished', async () => {
    const { cookie } = await sellerWithPublishedProduct(app, 'a@example.com', 'a-store');
    await putSettings(cookie, validStoreSettings);
    const res = await publishStore(cookie);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).isPublished, true);
    assert.equal((await storeRow()).isPublished, true);
    assert.equal((await publishStore(cookie)).statusCode, 200, 'idempotent');
    assert.equal(json(await unpublishStore(cookie)).isPublished, false);
    assert.equal(json(await unpublishStore(cookie)).isPublished, false, 'idempotent');
    assert.equal((await publishStore(cookie)).statusCode, 200, 'republish');
  });

  it('store and product publication are independent actions', async () => {
    const { cookie, productId } = await sellerWithPublishedProduct(app, 'a@example.com', 'a-store');
    // publishing a product did NOT publish the store
    assert.equal((await storeRow()).isPublished, false);
    await putSettings(cookie, validStoreSettings);
    await publishStore(cookie);
    // unpublishing the store leaves the product published
    await unpublishStore(cookie);
    assert.equal((await app.prisma.product.findUniqueOrThrow({ where: { id: productId } })).status, 'PUBLISHED');
    // unpublishing the product leaves the store flag alone
    await publishStore(cookie);
    await app.inject({ method: 'POST', url: `/api/seller/products/${productId}/unpublish`, headers: { cookie } });
    assert.equal((await storeRow()).isPublished, true);
  });

  it('two simultaneous publishes both succeed and publish once', async () => {
    const { cookie } = await sellerWithPublishedProduct(app, 'a@example.com', 'a-store');
    await putSettings(cookie, validStoreSettings);
    const [x, y] = await Promise.all([publishStore(cookie), publishStore(cookie)]);
    assert.deepEqual([x.statusCode, y.statusCode], [200, 200]);
  });

  it('a LIVE store must keep its phone and policies, but can change the delivery charge', async () => {
    const { cookie } = await sellerWithPublishedProduct(app, 'a@example.com', 'a-store');
    await putSettings(cookie, validStoreSettings);
    await publishStore(cookie);
    const before = await storeRow();
    for (const bad of [{ contactPhone: null }, { deliveryPolicy: '' }, { returnPolicy: 'short' }]) {
      const res = await putSettings(cookie, bad);
      assert.equal(res.statusCode, 400, JSON.stringify(bad));
      assert.equal(json(res).error.code, 'validation_error');
    }
    assert.deepEqual(await storeRow(), before, 'rejected edits change nothing');
    assert.equal((await putSettings(cookie, { deliveryCharge: '80', returnPolicy: 'Returns accepted within 7 days of delivery.' })).statusCode, 200);
    assert.equal((await storeRow()).deliveryChargePaise, 8000);
  });

  it('the store address is still locked once published (existing behaviour preserved)', async () => {
    const { cookie } = await sellerWithPublishedProduct(app, 'a@example.com', 'a-store');
    await putSettings(cookie, validStoreSettings);
    await publishStore(cookie);
    const res = await app.inject({ method: 'PUT', url: '/api/seller/store', headers: { cookie }, payload: { slug: 'new-name' } });
    assert.equal(res.statusCode, 409);
    assert.equal(json(res).error.code, 'slug_locked');
  });

  it('sellers are isolated: each only ever sees and changes their own store', async () => {
    const a = await sellerWithPublishedProduct(app, 'a@example.com', 'a-store');
    const b = await sellerWithStore(app, 'b@example.com', 'b-store');
    await putSettings(a.cookie, validStoreSettings);
    await publishStore(a.cookie);
    assert.equal(json(await getSettings(b)).settings.contactPhone, null);
    assert.equal(json(await getSettings(b)).isPublished, false);
    await putSettings(b, { contactPhone: '9000000001' });
    const stores = await app.prisma.store.findMany({ orderBy: { slug: 'asc' } });
    assert.deepEqual(stores.map((s) => [s.slug, s.contactPhone, s.isPublished]), [['a-store', '9811122233', true], ['b-store', '9000000001', false]]);
  });
});
