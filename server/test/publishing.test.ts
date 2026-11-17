import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { PUBLIC_PRODUCT_FILTER } from '../src/modules/products/visibility';
import { jpegBytes } from './images';
import { analyzeRequest, approveBrand, candleListing, fakeAi, makeApp, resetDb, sellerWithStore } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);
let app: FastifyInstance;
let handler: (n: number) => unknown;
const ai = fakeAi((req) => handler(ai.calls.length - 1));

before(async () => ({ app } = await makeApp({ CLAUDE_MODEL_SMART: 'claude-sonnet-5-5' }, ai)));
after(async () => app.close());
beforeEach(async () => {
  await resetDb();
  ai.calls.length = 0;
  handler = () => candleListing;
});

const seller = async (email = 'a@example.com', slug = 'a-store') => {
  const cookie = await sellerWithStore(app, email, slug);
  await approveBrand(app, cookie);
  return cookie;
};
const draft = async (cookie: string, notes?: string) => {
  const res = await analyzeRequest(app, cookie, jpegBytes(1568, 1000, 500), { notes });
  assert.equal(res.statusCode, 201, res.body);
  return json(res).product as { id: string };
};
const patch = (cookie: string, id: string, payload: unknown) => app.inject({ method: 'PATCH', url: `/api/seller/products/${id}`, headers: { cookie }, payload: payload as object });
const publish = (cookie: string, id: string, payload: unknown = { confirmAccuracy: true }) => app.inject({ method: 'POST', url: `/api/seller/products/${id}/publish`, headers: { cookie }, payload: payload as object });
const unpublish = (cookie: string, id: string) => app.inject({ method: 'POST', url: `/api/seller/products/${id}/unpublish`, headers: { cookie } });
const get = async (cookie: string, id: string) => json(await app.inject({ method: 'GET', url: `/api/seller/products/${id}`, headers: { cookie } })).product;
const row = (id: string) => app.prisma.product.findUniqueOrThrow({ where: { id }, include: { images: true } });
const ready = async (cookie: string) => {
  const p = await draft(cookie);
  assert.equal((await patch(cookie, p.id, { price: '499', stock: 5 })).statusCode, 200);
  return p;
};

describe('publish: access, readiness and rules', () => {
  it('requires authentication on publish, unpublish and regenerate', async () => {
    for (const url of ['publish', 'unpublish', 'regenerate']) {
      assert.equal((await app.inject({ method: 'POST', url: `/api/seller/products/x/${url}`, payload: {} })).statusCode, 401, url);
    }
  });

  it('a fresh AI draft is NOT publishable, and publishing never fills in price or stock', async () => {
    const cookie = await seller();
    const p = await draft(cookie);
    const res = await publish(cookie, p.id);
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error.code, 'not_publishable');
    assert.deepEqual(Object.keys(json(res).error.fields).sort(), ['price', 'stock']);
    const r = await row(p.id);
    assert.equal(r.status, 'DRAFT');
    assert.equal(r.publishedAt, null);
    assert.equal(r.pricePaise, null);
    assert.equal(r.stock, 0);
  });

  it('GET reports server-computed readiness that follows the saved data', async () => {
    const cookie = await seller();
    const p = await draft(cookie);
    const before = await get(cookie, p.id);
    assert.equal(before.readiness.canPublish, false);
    assert.deepEqual(before.readiness.issues.map((i: { field: string }) => i.field).sort(), ['price', 'stock']);
    await patch(cookie, p.id, { price: '299', stock: 3 });
    const after = await get(cookie, p.id);
    assert.deepEqual(after.readiness, { canPublish: true, issues: [] });
  });

  it('each required field is enforced on its own (backend is authoritative)', async () => {
    const cookie = await seller();
    const store = await app.prisma.store.findFirstOrThrow();
    const cases: [string, Record<string, unknown>, string][] = [
      ['no price', { pricePaise: null }, 'price'],
      ['zero stock', { stock: 0 }, 'stock'],
      ['short description', { description: 'too short' }, 'description'],
      ['blank description', { description: '   ' }, 'description'],
      ['no category', { category: null }, 'category'],
      ['one-letter title', { title: 'a' }, 'title'],
    ];
    for (const [name, over, field] of cases) {
      // The photo must be real now: publishing verifies the file exists in storage with its recorded size.
      const key = `products/${store.id}/fixture-${Math.random().toString(36).slice(2)}.jpg`;
      const bytes = jpegBytes(800, 600, 200);
      await app.storage.put(key, bytes);
      const p = await app.prisma.product.create({
        data: {
          storeId: store.id, slug: `p-${Math.random().toString(36).slice(2)}`, title: 'Glass jar candle', description: 'A calm candle in a clear glass jar.',
          category: 'Home Décor', pricePaise: 49900, stock: 4, images: { create: { storageKey: key, mimeType: 'image/jpeg', sizeBytes: bytes.length } }, ...over,
        } as never,
      });
      const res = await publish(cookie, p.id);
      assert.equal(res.statusCode, 400, name);
      assert.deepEqual(Object.keys(json(res).error.fields), [field], name);
      assert.equal((await row(p.id)).status, 'DRAFT', name);
    }
    // no photo at all
    const noImg = await app.prisma.product.create({ data: { storeId: store.id, slug: 'no-img', title: 'Candle', description: 'A calm candle in a glass jar.', category: 'Home Décor', pricePaise: 100, stock: 1 } });
    const res = await publish(cookie, noImg.id);
    assert.deepEqual(Object.keys(json(res).error.fields), ['image']);
  });

  it('requires the explicit accuracy confirmation in the API itself', async () => {
    const cookie = await seller();
    const p = await ready(cookie);
    const noBody = () => app.inject({ method: 'POST', url: `/api/seller/products/${p.id}/publish`, headers: { cookie } }); // no payload at all
    const attempts = [noBody, ...[{}, { confirmAccuracy: false }, { confirmAccuracy: 'yes' }, { confirmAccuracy: 1 }, { confirmAccuracy: null }].map((b) => () => publish(cookie, p.id, b))];
    for (const [i, attempt] of attempts.entries()) {
      const res = await attempt();
      assert.equal(res.statusCode, 400, `attempt ${i}`);
      assert.equal(json(res).error.code, 'validation_error');
      assert.ok(json(res).error.fields.confirmAccuracy);
    }
    assert.equal((await row(p.id)).status, 'DRAFT');
  });

  it('publishes a complete product, sets publishedAt, and does NOT touch Store.isPublished', async () => {
    const cookie = await seller();
    const p = await ready(cookie);
    const before = await row(p.id);
    const res = await publish(cookie, p.id);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).product.status, 'PUBLISHED');
    const after = await row(p.id);
    assert.equal(after.status, 'PUBLISHED');
    assert.ok(after.publishedAt instanceof Date);
    assert.deepEqual(
      { title: after.title, description: after.description, price: after.pricePaise, stock: after.stock, brand: after.brandVersion, aiDraft: after.aiDraft },
      { title: before.title, description: before.description, price: 49900, stock: 5, brand: before.brandVersion, aiDraft: before.aiDraft },
    );
    assert.equal((await app.prisma.store.findFirstOrThrow()).isPublished, false);
  });

  it('is idempotent: publishing twice keeps the first publishedAt', async () => {
    const cookie = await seller();
    const p = await ready(cookie);
    await publish(cookie, p.id);
    const first = (await row(p.id)).publishedAt!;
    const again = await publish(cookie, p.id);
    assert.equal(again.statusCode, 200);
    assert.equal((await row(p.id)).publishedAt!.getTime(), first.getTime());
  });

  it('ARCHIVED products can be neither published nor unpublished', async () => {
    const cookie = await seller();
    const p = await ready(cookie);
    await app.prisma.product.update({ where: { id: p.id }, data: { status: 'ARCHIVED' } });
    for (const res of [await publish(cookie, p.id), await unpublish(cookie, p.id)]) {
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).error.code, 'invalid_state');
    }
    assert.equal((await row(p.id)).status, 'ARCHIVED');
  });

  it('unpublish returns the product to DRAFT unchanged, and it can be edited and republished', async () => {
    const cookie = await seller();
    const p = await ready(cookie);
    await publish(cookie, p.id);
    const live = await row(p.id);
    const res = await unpublish(cookie, p.id);
    assert.equal(res.statusCode, 200);
    const back = await row(p.id);
    assert.equal(back.status, 'DRAFT');
    assert.equal(back.publishedAt, null);
    assert.deepEqual({ t: back.title, d: back.description, p: back.pricePaise, s: back.stock }, { t: live.title, d: live.description, p: live.pricePaise, s: live.stock });
    assert.equal((await unpublish(cookie, p.id)).statusCode, 200); // idempotent
    assert.equal((await patch(cookie, p.id, { description: '' })).statusCode, 200); // drafts are editable again
    await patch(cookie, p.id, { description: 'A calm candle in a clear glass jar.' });
    assert.equal((await publish(cookie, p.id)).statusCode, 200);
  });

  it('/api/auth/me reports product counts', async () => {
    const cookie = await seller();
    const a = await ready(cookie);
    await draft(cookie);
    const me = async () => json(await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).counts;
    assert.deepEqual(await me(), { products: 2, published: 0 });
    await publish(cookie, a.id);
    assert.deepEqual(await me(), { products: 2, published: 1 });
    await unpublish(cookie, a.id);
    assert.deepEqual(await me(), { products: 2, published: 0 });
  });
});

describe('seller isolation for publishing operations', () => {
  it('another seller gets 404 on publish, unpublish, regenerate and edit, and nothing changes', async () => {
    const a = await seller('a@example.com', 'a-store');
    const b = await seller('b@example.com', 'b-store');
    const p = await ready(a);
    await publish(a, p.id);
    const before = await row(p.id);
    ai.calls.length = 0;
    const attempts = [
      await publish(b, p.id),
      await unpublish(b, p.id),
      await app.inject({ method: 'POST', url: `/api/seller/products/${p.id}/regenerate`, headers: { cookie: b }, payload: { answers: [] } }),
      await patch(b, p.id, { price: '1' }),
    ];
    for (const r of attempts) assert.equal(r.statusCode, 404);
    assert.deepEqual(await row(p.id), before);
    assert.equal(ai.calls.length, 0, 'no Claude call for someone else’s product');
    // B's own publish of a draft is unaffected by A's published product
    const own = await ready(b);
    assert.equal((await publish(b, own.id)).statusCode, 200);
  });
});

describe('editing a LIVE product must keep it publishable', () => {
  const live = async () => {
    const cookie = await seller();
    const p = await ready(cookie);
    await publish(cookie, p.id);
    return { cookie, id: p.id };
  };

  it('rejects edits that would make it incomplete and writes nothing', async () => {
    const { cookie, id } = await live();
    const before = await row(id);
    const bad: [string, Record<string, unknown>, string][] = [
      ['remove price', { price: null }, 'price'],
      ['blank price', { price: '' }, 'price'],
      ['empty description', { description: '' }, 'description'],
      ['short description', { description: 'short' }, 'description'],
      ['remove category', { category: null }, 'category'],
    ];
    for (const [name, payload, field] of bad) {
      const res = await patch(cookie, id, payload);
      assert.equal(res.statusCode, 400, name);
      assert.equal(json(res).error.code, 'validation_error');
      assert.ok(json(res).error.fields[field], name);
    }
    assert.deepEqual(await row(id), before);
  });

  it('allows valid edits, price changes and selling out (stock 0) while staying published', async () => {
    const { cookie, id } = await live();
    assert.equal((await patch(cookie, id, { title: 'A better title', price: '549.50', tags: ['gift'] })).statusCode, 200);
    const sold = await patch(cookie, id, { stock: 0 });
    assert.equal(sold.statusCode, 200);
    const r = await row(id);
    assert.deepEqual({ status: r.status, title: r.title, price: r.pricePaise, stock: r.stock, tags: r.tags }, { status: 'PUBLISHED', title: 'A better title', price: 54950, stock: 0, tags: ['gift'] });
  });

  it('keeps drafts lenient (work in progress can be saved) and ignores status in PATCH', async () => {
    const cookie = await seller();
    const p = await draft(cookie);
    assert.equal((await patch(cookie, p.id, { description: '' })).statusCode, 200);
    await patch(cookie, p.id, { status: 'PUBLISHED' });
    assert.equal((await row(p.id)).status, 'DRAFT');
  });

  it('an invalid multi-field edit is atomic: nothing is saved, not even the valid fields', async () => {
    const { cookie, id } = await live();
    const before = await row(id);
    const res = await patch(cookie, id, { title: 'Valid new title', price: null });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(await row(id), before);
  });
});

describe('database CHECK constraints (last line of defence)', () => {
  const exec = (sql: string) => app.prisma.$executeRawUnsafe(sql);
  let id: string;
  beforeEach(async () => {
    const cookie = await seller();
    id = (await draft(cookie)).id;
  });

  it('refuses a PUBLISHED row without a positive price', async () => {
    await assert.rejects(() => exec(`UPDATE products SET status='PUBLISHED', "publishedAt"=now() WHERE id='${id}'`), /products_published_requires_price_chk/);
    await assert.rejects(() => exec(`UPDATE products SET status='PUBLISHED', "publishedAt"=now(), "pricePaise"=0 WHERE id='${id}'`), /products_published_requires_price_chk/);
    await assert.rejects(() => app.prisma.product.update({ where: { id }, data: { status: 'PUBLISHED', publishedAt: new Date() } }), /products_published_requires_price_chk/);
  });

  it('refuses a PUBLISHED row without a publish time or a real title', async () => {
    await assert.rejects(() => exec(`UPDATE products SET status='PUBLISHED', "pricePaise"=100 WHERE id='${id}'`), /products_published_requires_publishedat_chk/);
    await assert.rejects(() => exec(`UPDATE products SET status='PUBLISHED', "publishedAt"=now(), "pricePaise"=100, title='  ' WHERE id='${id}'`), /products_published_requires_title_chk/);
  });

  it('refuses negative stock, and allows a valid published row', async () => {
    await assert.rejects(() => exec(`UPDATE products SET stock=-1 WHERE id='${id}'`), /products_stock_nonnegative_chk/);
    await exec(`UPDATE products SET status='PUBLISHED', "publishedAt"=now(), "pricePaise"=100 WHERE id='${id}'`);
    assert.equal((await row(id)).status, 'PUBLISHED');
  });
});

describe('concurrency: a live product can never be left invalid', () => {
  it('publish racing a price-clearing edit always ends in a consistent state', async () => {
    const cookie = await seller();
    const outcomes = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const p = await ready(cookie);
      const [pub, edit] = await Promise.all([publish(cookie, p.id), patch(cookie, p.id, { price: null })]);
      const r = await row(p.id);
      outcomes.add(`${pub.statusCode}/${edit.statusCode}`);
      // either the publish won (then the edit was refused) or the edit won (then the publish was refused)
      assert.ok(['200/400', '400/200'].includes(`${pub.statusCode}/${edit.statusCode}`), `${pub.statusCode}/${edit.statusCode}`);
      if (r.status === 'PUBLISHED') {
        assert.ok(r.pricePaise !== null && r.pricePaise > 0, 'published implies a price');
        assert.ok(r.publishedAt);
      } else {
        assert.equal(r.pricePaise, null);
      }
    }
    assert.ok(outcomes.size >= 1);
  });

  it('two simultaneous publishes both succeed and publish exactly once', async () => {
    const cookie = await seller();
    const p = await ready(cookie);
    const [x, y] = await Promise.all([publish(cookie, p.id), publish(cookie, p.id)]);
    assert.deepEqual([x.statusCode, y.statusCode], [200, 200]);
    assert.equal((await row(p.id)).status, 'PUBLISHED');
  });
});

describe('customer visibility rule for the future storefront', () => {
  it('PUBLIC_PRODUCT_FILTER returns only PUBLISHED products, across stores', async () => {
    const a = await seller('a@example.com', 'a-store');
    const b = await seller('b@example.com', 'b-store');
    const [pa, pb] = [await ready(a), await ready(b)];
    await publish(a, pa.id);
    await draft(a); // a draft
    const archived = await ready(b);
    await publish(b, archived.id);
    await app.prisma.product.update({ where: { id: archived.id }, data: { status: 'ARCHIVED', publishedAt: null } });
    void pb;
    assert.deepEqual(PUBLIC_PRODUCT_FILTER, { status: 'PUBLISHED' });
    const visible = await app.prisma.product.findMany({ where: { ...PUBLIC_PRODUCT_FILTER } });
    assert.deepEqual(visible.map((p) => p.id), [pa.id]);
    const stores = await app.prisma.store.findMany();
    const aStore = stores.find((s) => s.slug === 'a-store')!;
    assert.equal((await app.prisma.product.findMany({ where: { storeId: aStore.id, ...PUBLIC_PRODUCT_FILTER } })).length, 1);
    // the seller's own list still shows every status
    const mine = json(await app.inject({ method: 'GET', url: '/api/seller/products', headers: { cookie: a } })).products;
    assert.deepEqual(mine.map((p: { status: string }) => p.status).sort(), ['DRAFT', 'PUBLISHED']);
  });
});
