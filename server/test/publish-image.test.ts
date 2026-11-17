import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { isImageUsable } from '../src/modules/products/publishing';
import { jpegBytes } from './images';
import { analyzeRequest, approveBrand, candleListing, fakeAi, makeApp, resetDb, sellerWithStore } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);
let app: FastifyInstance;
let uploadDir: string;
const ai = fakeAi(() => candleListing);

before(async () => ({ app, uploadDir } = await makeApp({}, ai)));
after(async () => app.close());
beforeEach(async () => {
  await resetDb();
  ai.calls.length = 0;
});

const photo = jpegBytes(1568, 1000, 800);

async function readyProduct(email = 'a@example.com', slug = 'a-store') {
  const cookie = await sellerWithStore(app, email, slug);
  await approveBrand(app, cookie);
  const res = await analyzeRequest(app, cookie, photo);
  assert.equal(res.statusCode, 201, res.body);
  const id = json(res).product.id as string;
  const patched = await app.inject({ method: 'PATCH', url: `/api/seller/products/${id}`, headers: { cookie }, payload: { price: '499', stock: 4 } });
  assert.equal(patched.statusCode, 200, patched.body);
  const image = await app.prisma.productImage.findFirstOrThrow({ where: { productId: id } });
  return { cookie, id, image, file: path.join(uploadDir, image.storageKey) };
}
const publish = (cookie: string, id: string) => app.inject({ method: 'POST', url: `/api/seller/products/${id}/publish`, headers: { cookie }, payload: { confirmAccuracy: true } });
const snapshot = (id: string) => app.prisma.product.findUniqueOrThrow({ where: { id }, include: { images: true } });

/** Counts calls to the storage driver while `fn` runs. */
async function withStorageSpy<T>(fn: () => Promise<T>) {
  const calls = { stat: 0, get: 0 };
  const { stat, get } = app.storage;
  app.storage.stat = async (k) => { calls.stat++; return stat(k); };
  app.storage.get = async (k) => { calls.get++; return get(k); };
  try {
    return { result: await fn(), calls };
  } finally {
    app.storage.stat = stat;
    app.storage.get = get;
  }
}

describe('publishing verifies the photo file, not just the database row', () => {
  it('a valid, accessible photo publishes', async () => {
    const { cookie, id } = await readyProduct();
    const res = await publish(cookie, id);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(json(res).product.status, 'PUBLISHED');
  });

  it('a MISSING file is refused with a clear 400, no paths leaked, and the draft is untouched', async () => {
    const { cookie, id, image, file } = await readyProduct();
    fs.unlinkSync(file);
    const before = await snapshot(id);

    const res = await publish(cookie, id);
    assert.equal(res.statusCode, 400);
    const err = json(res).error;
    assert.equal(err.code, 'not_publishable');
    assert.deepEqual(Object.keys(err.fields), ['image']);
    assert.match(err.message, /photo.*could not be found/i);
    for (const secret of [uploadDir, image.storageKey, 'products/', 'ENOENT', '/tmp', '/var']) {
      assert.ok(!res.body.includes(secret), `response must not contain "${secret}"`);
    }

    assert.deepEqual(await snapshot(id), before); // nothing about the product or its image row changed
    assert.equal(fs.existsSync(file), false, 'nothing recreated or deleted anything on disk');

    // The draft stays fully usable
    const edit = await app.inject({ method: 'PATCH', url: `/api/seller/products/${id}`, headers: { cookie }, payload: { title: 'Still editable' } });
    assert.equal(edit.statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: `/api/seller/products/${id}`, headers: { cookie } })).statusCode, 200);

    // ...and once the file is back, publishing works
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, photo);
    assert.equal((await publish(cookie, id)).statusCode, 200);
  });

  it('a file with the wrong size (truncated or replaced) is refused', async () => {
    const { cookie, id, file } = await readyProduct();
    fs.writeFileSync(file, photo.subarray(0, photo.length - 100));
    assert.equal((await publish(cookie, id)).statusCode, 400, 'truncated');
    fs.writeFileSync(file, Buffer.concat([photo, Buffer.from('extra')]));
    assert.equal((await publish(cookie, id)).statusCode, 400, 'grown');
    fs.writeFileSync(file, Buffer.alloc(0));
    assert.equal((await publish(cookie, id)).statusCode, 400, 'empty');
    assert.equal((await snapshot(id)).status, 'DRAFT');
    fs.writeFileSync(file, photo);
    assert.equal((await publish(cookie, id)).statusCode, 200, 'restored');
  });

  it('a directory sitting where the file should be is refused', async () => {
    const { cookie, id, file } = await readyProduct();
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    const res = await publish(cookie, id);
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error.code, 'not_publishable');
    assert.equal((await snapshot(id)).status, 'DRAFT');
  });

  it('an inaccessible storage folder is refused without exposing errors', async () => {
    const { cookie, id, file } = await readyProduct();
    const dir = path.dirname(file);
    fs.chmodSync(dir, 0o000);
    try {
      const res = await publish(cookie, id);
      assert.equal(res.statusCode, 400);
      assert.ok(!/EACCES|permission|denied/i.test(res.body) && !res.body.includes(uploadDir), 'no filesystem details in the response');
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    assert.equal((await snapshot(id)).status, 'DRAFT');
    assert.equal((await publish(cookie, id)).statusCode, 200, 'works once access is restored');
  });

  it('only needs ONE usable photo: a second, missing photo row does not block publishing', async () => {
    const { cookie, id } = await readyProduct();
    await app.prisma.productImage.create({ data: { productId: id, storageKey: 'products/none/gone.jpg', mimeType: 'image/jpeg', sizeBytes: 123, position: 1 } });
    assert.equal((await publish(cookie, id)).statusCode, 200);
  });

  it('reports a missing photo together with other missing fields', async () => {
    const { cookie, id, file } = await readyProduct();
    fs.unlinkSync(file);
    await app.prisma.product.update({ where: { id }, data: { pricePaise: null } });
    const res = await publish(cookie, id);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(Object.keys(json(res).error.fields).sort(), ['image', 'price']);
    assert.equal(json(res).error.message, 'This product is not ready to publish yet.');
  });

  it('a product with no photo row still says "Add a product photo."', async () => {
    const cookie = await sellerWithStore(app, 'a@example.com', 'a-store');
    const store = await app.prisma.store.findFirstOrThrow();
    const p = await app.prisma.product.create({ data: { storeId: store.id, slug: 'no-photo', title: 'Candle', description: 'A calm candle in a glass jar.', category: 'Home Décor', pricePaise: 100, stock: 1 } });
    const res = await publish(cookie, p.id);
    assert.equal(res.statusCode, 400);
    assert.equal(json(res).error.fields.image, 'Add a product photo.');
  });
});

describe('seller isolation is preserved', () => {
  it('another seller gets a plain 404 (no hint about the photo), and storage is not even touched', async () => {
    const a = await readyProduct('a@example.com', 'a-store');
    fs.unlinkSync(a.file);
    const b = await sellerWithStore(app, 'b@example.com', 'b-store');
    await approveBrand(app, b);
    const before = await snapshot(a.id);
    const { result, calls } = await withStorageSpy(() => publish(b, a.id));
    assert.equal(result.statusCode, 404);
    assert.equal(json(result).error.code, 'not_found');
    assert.ok(!/photo|storage|image/i.test(result.body), 'no information about the other seller’s photo');
    assert.deepEqual(calls, { stat: 0, get: 0 });
    assert.deepEqual(await snapshot(a.id), before);
  });
});

describe('I/O stays small and bounded', () => {
  it('publishing a draft costs exactly one metadata stat per photo and never reads file contents', async () => {
    const { cookie, id } = await readyProduct();
    const { result, calls } = await withStorageSpy(() => publish(cookie, id));
    assert.equal(result.statusCode, 200);
    assert.deepEqual(calls, { stat: 1, get: 0 });
  });

  it('no storage I/O at all for reading, listing, already-live or archived products', async () => {
    const { cookie, id } = await readyProduct();
    assert.equal((await publish(cookie, id)).statusCode, 200);
    const { calls } = await withStorageSpy(async () => {
      await app.inject({ method: 'GET', url: `/api/seller/products/${id}`, headers: { cookie } });
      await app.inject({ method: 'GET', url: '/api/seller/products', headers: { cookie } });
      assert.equal((await publish(cookie, id)).statusCode, 200, 'idempotent re-publish');
      await app.prisma.product.update({ where: { id }, data: { status: 'ARCHIVED', publishedAt: null } });
      assert.equal((await publish(cookie, id)).statusCode, 409, 'archived');
    });
    assert.deepEqual(calls, { stat: 0, get: 0 });
  });

  it('an already-live product is not affected if its file later disappears (publish stays idempotent)', async () => {
    const { cookie, id, file } = await readyProduct();
    await publish(cookie, id);
    fs.unlinkSync(file);
    assert.equal((await publish(cookie, id)).statusCode, 200);
    assert.equal((await snapshot(id)).status, 'PUBLISHED'); // never silently un-published or modified
    assert.equal((await app.inject({ method: 'POST', url: `/api/seller/products/${id}/unpublish`, headers: { cookie } })).statusCode, 200);
    assert.equal((await publish(cookie, id)).statusCode, 400, 'but re-publishing after unpublish needs the file');
  });

  it('GET readiness is database-only (cheap on lists); the file check happens at publish time', async () => {
    const { cookie, id, file } = await readyProduct();
    fs.unlinkSync(file);
    const { result, calls } = await withStorageSpy(() => app.inject({ method: 'GET', url: `/api/seller/products/${id}`, headers: { cookie } }));
    assert.equal(json(result).product.readiness.canPublish, true);
    assert.equal(calls.stat, 0);
    assert.equal((await publish(cookie, id)).statusCode, 400);
  });
});

describe('Storage.stat and isImageUsable', () => {
  it('stat returns the size of a regular file and null for everything else', async () => {
    const key = 'products/unit/probe.jpg';
    await app.storage.put(key, Buffer.from('12345'));
    assert.deepEqual(await app.storage.stat(key), { size: 5 });
    assert.equal(await app.storage.stat('products/unit/missing.jpg'), null);
    assert.equal(await app.storage.stat('products/unit'), null, 'a directory is not a file');
    assert.equal(await app.storage.stat('../../etc/passwd'), null, 'path traversal');
    assert.equal(await app.storage.stat('/etc/passwd'), null, 'absolute path outside storage');
    await app.storage.delete(key);
  });

  it('isImageUsable requires a non-empty file of exactly the recorded size', async () => {
    const key = 'products/unit/size.jpg';
    await app.storage.put(key, Buffer.from('12345'));
    assert.equal(await isImageUsable(app.storage, { storageKey: key, sizeBytes: 5 }), true);
    assert.equal(await isImageUsable(app.storage, { storageKey: key, sizeBytes: 6 }), false);
    await app.storage.put(key, Buffer.alloc(0));
    assert.equal(await isImageUsable(app.storage, { storageKey: key, sizeBytes: 0 }), false, 'empty file is never usable');
    assert.equal(await isImageUsable(app.storage, { storageKey: 'products/unit/nope.jpg', sizeBytes: 5 }), false);
    await app.storage.delete(key);
  });
});
