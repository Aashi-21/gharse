import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { jpegBytes } from './images';
import { analyzeRequest, approveBrand, candleListing, makeApp, resetDb, sellerWithStore } from './helpers';

// Regeneration through the REAL Claude wrapper against a local stand-in for api.anthropic.com.
type Reply = { status: number; body: unknown; hang?: boolean };
let server: http.Server;
let queue: Reply[] = [];
let received: any[] = [];
let app: FastifyInstance;
let cookie: string;
let id: string;
const photo = jpegBytes(1568, 1000, 700);

const message = (text: string, extra: object = {}) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1700, output_tokens: 450 }, ...extra,
});
const better = {
  ...candleListing,
  title: 'Soy Candle in Glass Jar',
  description: 'A candle in a clear glass jar with a plain cream label, made with soy wax. A calm little glow for a quiet corner.',
  tags: ['candle', 'soy wax', 'glass jar'],
  openQuestions: [{ attribute: 'size', question: 'What is the size or weight of the candle?' }],
};
const imageFiles = () => fs.readdirSync(path.join(app.config.uploadDir, 'products'), { recursive: true }).filter((f) => /\.jpg$/.test(String(f))).length;
const row = () => app.prisma.product.findUniqueOrThrow({ where: { id }, include: { images: true } });
const regen = () => app.inject({ method: 'POST', url: `/api/seller/products/${id}/regenerate`, headers: { cookie }, payload: { answers: [{ attribute: 'material', answer: 'Soy wax' }] } });
const body = (r: { body: string }) => JSON.parse(r.body);

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push(JSON.parse(raw || '{}'));
      const r = queue.shift() ?? { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'queue empty' } } };
      if (r.hang) return;
      res.writeHead(r.status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ({ app } = await makeApp({ ANTHROPIC_API_KEY: 'sk-test-not-real', AI_TIMEOUT_MS: '5000', AI_MAX_RETRIES: '0' }));
});
after(async () => {
  await app.close();
  server.closeAllConnections();
  server.close();
  delete process.env.ANTHROPIC_BASE_URL;
});
beforeEach(async () => {
  await resetDb();
  queue = [];
  received = [];
  cookie = await sellerWithStore(app, 'a@example.com', 'a-store');
  await approveBrand(app, cookie);
  queue.push({ status: 200, body: message(JSON.stringify(candleListing)) });
  const created = await analyzeRequest(app, cookie, photo, { notes: 'a candle' });
  assert.equal(created.statusCode, 201, created.body);
  id = body(created).product.id;
  await app.inject({ method: 'PATCH', url: `/api/seller/products/${id}`, headers: { cookie }, payload: { price: '449', stock: 7 } });
  received = [];
  await app.prisma.aiGeneration.deleteMany();
});

describe('regeneration through the real Claude client', () => {
  it('success: sends the saved photo + brand + answers, replaces AI fields, preserves price/stock, logs usage against the product', async () => {
    queue.push({ status: 200, body: message(JSON.stringify(better)) });
    const res = await regen();
    assert.equal(res.statusCode, 200, res.body);
    const sent = received[0];
    assert.equal(sent.messages[0].content[0].source.data, photo.toString('base64'));
    assert.ok(sent.system.includes('Ember & Wick'), 'brand in prompt');
    assert.ok(sent.messages[0].content[1].text.includes('Soy wax'), 'answer in prompt');
    assert.equal(sent.output_config.format.type, 'json_schema');
    const after = await row();
    assert.equal(after.title, better.title);
    assert.deepEqual({ p: after.pricePaise, s: after.stock, st: after.status }, { p: 44900, s: 7, st: 'DRAFT' });
    const gen = await app.prisma.aiGeneration.findFirstOrThrow();
    assert.deepEqual(
      { kind: gen.kind, status: gen.status, productId: gen.productId, brandVersion: gen.brandVersion, inputTokens: gen.inputTokens, outputTokens: gen.outputTokens },
      { kind: 'LISTING', status: 'SUCCESS', productId: id, brandVersion: 1, inputTokens: 1700, outputTokens: 450 },
    );
  });

  it('API errors: safe messages, product byte-for-byte unchanged, errors logged against the product', async () => {
    const cases: [number, object, number, string][] = [
      [429, { type: 'error', error: { type: 'rate_limit_error', message: 'internal quota detail' } }, 429, 'ai_busy'],
      [529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }, 502, 'ai_unavailable'],
      [500, { type: 'error', error: { type: 'api_error', message: 'x' } }, 502, 'ai_unavailable'],
      [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid key sk-test-not-real' } }, 503, 'ai_not_configured'],
      [400, { type: 'error', error: { type: 'invalid_request_error', message: 'credit balance is too low' } }, 502, 'ai_request_failed'],
    ];
    const before = await row();
    for (const [status, errBody, expectStatus, code] of cases) {
      queue.push({ status, body: errBody });
      const res = await regen();
      assert.equal(res.statusCode, expectStatus, code);
      assert.equal(body(res).error.code, code);
      assert.ok(!/internal quota|sk-test|credit balance/.test(res.body), 'no upstream detail leaks');
      assert.deepEqual(await row(), before);
    }
    const errors = await app.prisma.aiGeneration.findMany({ where: { status: 'ERROR' } });
    assert.equal(errors.length, cases.length);
    assert.ok(errors.every((e) => e.productId === id && e.kind === 'LISTING'), 'error rows linked to the product');
  });

  it('timeout: clean 504 and the product is unchanged', async () => {
    const before = await row();
    queue.push({ status: 200, body: {}, hang: true });
    const res = await regen();
    assert.equal(res.statusCode, 504);
    assert.equal(body(res).error.code, 'ai_timeout');
    assert.deepEqual(await row(), before);
  });

  it('invalid structured output (twice) and missing fields: 502, unchanged', async () => {
    const before = await row();
    queue.push({ status: 200, body: message('Here you go: {nope') }, { status: 200, body: message(JSON.stringify({ ...better, category: 'Weapons' })) });
    const a = await regen();
    assert.equal(a.statusCode, 502);
    assert.equal(body(a).error.code, 'ai_invalid_output');
    const { title: _t, description: _d, ...partial } = better;
    queue.push({ status: 200, body: message(JSON.stringify(partial)) }, { status: 200, body: message(JSON.stringify(partial)) });
    assert.equal((await regen()).statusCode, 502);
    assert.deepEqual(await row(), before);
  });

  it('a refusal is a friendly 422 and changes nothing', async () => {
    const before = await row();
    queue.push({ status: 200, body: message('', { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }) });
    const res = await regen();
    assert.equal(res.statusCode, 422);
    assert.deepEqual(await row(), before);
  });

  it('invented claims twice (via the real client): 502 ai_unsupported_claims and nothing saved', async () => {
    const before = await row();
    const filesBefore = imageFiles();
    const bad = { ...better, description: 'A handmade candle with a lovely lavender scent, 200 g, premium quality.' };
    queue.push({ status: 200, body: message(JSON.stringify(bad)) }, { status: 200, body: message(JSON.stringify(bad)) });
    const res = await regen();
    assert.equal(res.statusCode, 502);
    assert.equal(body(res).error.code, 'ai_unsupported_claims');
    assert.equal(received.length, 2);
    assert.match(received[1].messages[0].content.at(-1).text, /handmade/);
    assert.deepEqual(await row(), before);
    assert.equal(imageFiles(), filesBefore, 'a failed regeneration writes no files');
  });

  it('invented claims once, then a clean answer: corrective retry succeeds', async () => {
    queue.push({ status: 200, body: message(JSON.stringify({ ...better, description: 'A handmade candle in a glass jar, premium and long-lasting.' })) });
    queue.push({ status: 200, body: message(JSON.stringify(better)) });
    const res = await regen();
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(received.length, 2);
    assert.equal((await row()).description, better.description);
  });
});
