import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { jpegBytes } from './images';
import { analyzeRequest, approveBrand, candleListing, makeApp, resetDb, sellerWithStore } from './helpers';

// The REAL Claude wrapper talking to a local stand-in for api.anthropic.com: proves that Claude failures
// during product analysis leave nothing behind and surface safe errors.
type Reply = { status: number; body: unknown; hang?: boolean };
let server: http.Server;
let queue: Reply[] = [];
let received: any[] = [];
let app: FastifyInstance;
let uploadDir: string;
let cookie: string;

const message = (text: string, extra: object = {}) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 1500, output_tokens: 400 }, ...extra,
});
const filesUnder = () => (fs.existsSync(path.join(uploadDir, 'products')) ? fs.readdirSync(path.join(uploadDir, 'products'), { recursive: true }).filter((f) => /\.(jpg|png|webp)$/.test(String(f))) : []);
const analyze = () => analyzeRequest(app, cookie, jpegBytes(1568, 1000, 500), { notes: 'a candle' });
const nothingSaved = async () => {
  assert.equal(await app.prisma.product.count(), 0);
  assert.equal(await app.prisma.productImage.count(), 0);
  assert.equal(filesUnder().length, 0);
};

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push(JSON.parse(raw || '{}'));
      const r = queue.shift() ?? { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'queue empty' } } };
      if (r.hang) return; // never answer: simulates a stalled upstream
      res.writeHead(r.status, { 'content-type': 'application/json', 'x-should-retry': 'false' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ({ app, uploadDir } = await makeApp({ ANTHROPIC_API_KEY: 'sk-test-not-real', AI_TIMEOUT_MS: '5000', AI_MAX_RETRIES: '0' }));
});
after(async () => {
  await app.close();
  server.closeAllConnections();
  server.close();
  delete process.env.ANTHROPIC_BASE_URL;
});
beforeEach(async () => {
  await resetDb();
  fs.rmSync(path.join(uploadDir, 'products'), { recursive: true, force: true });
  queue = [];
  received = [];
  cookie = await sellerWithStore(app, 'a@example.com', 'a-store');
  await approveBrand(app, cookie);
});

describe('product analysis through the real Claude client wrapper', () => {
  it('success: sends image + brand + structured-output schema, logs usage linked to the product', async () => {
    queue.push({ status: 200, body: message(JSON.stringify(candleListing)) });
    const res = await analyze();
    assert.equal(res.statusCode, 201, res.body);
    const sent = received[0];
    assert.equal(sent.model, 'claude-sonnet-5-5');
    assert.equal(sent.messages[0].content[0].type, 'image');
    assert.equal(sent.messages[0].content[0].source.type, 'base64');
    assert.ok(sent.system.includes('Ember & Wick'), 'brand from the database is in the prompt');
    assert.equal(sent.output_config.format.type, 'json_schema');
    for (const k of ['title', 'description', 'category', 'tags', 'visibleCharacteristics', 'openQuestions']) assert.ok(sent.output_config.format.schema.properties[k], k);
    assert.equal(sent.tool_choice, undefined);
    assert.equal(sent.temperature, undefined);

    const gen = await app.prisma.aiGeneration.findFirstOrThrow();
    assert.deepEqual(
      { kind: gen.kind, model: gen.model, status: gen.status, inputTokens: gen.inputTokens, outputTokens: gen.outputTokens, brandVersion: gen.brandVersion, productId: gen.productId },
      { kind: 'LISTING', model: 'claude-sonnet-5-5', status: 'SUCCESS', inputTokens: 1500, outputTokens: 400, brandVersion: 1, productId: JSON.parse(res.body).product.id },
    );
  });

  it('API errors: safe messages, no upstream details, nothing saved, errors logged', async () => {
    const cases: [number, object, number, string][] = [
      [429, { type: 'error', error: { type: 'rate_limit_error', message: 'internal quota detail' } }, 429, 'ai_busy'],
      [529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }, 502, 'ai_unavailable'],
      [500, { type: 'error', error: { type: 'api_error', message: 'x' } }, 502, 'ai_unavailable'],
      [401, { type: 'error', error: { type: 'authentication_error', message: 'invalid key sk-test-not-real' } }, 503, 'ai_not_configured'],
      [400, { type: 'error', error: { type: 'invalid_request_error', message: 'credit balance is too low' } }, 502, 'ai_request_failed'],
    ];
    for (const [status, body, expectStatus, code] of cases) {
      queue.push({ status, body });
      const res = await analyze();
      assert.equal(res.statusCode, expectStatus, code);
      assert.equal(JSON.parse(res.body).error.code, code);
      assert.ok(!/internal quota|sk-test|credit balance/.test(res.body), 'no upstream details leak to the seller');
      await nothingSaved();
    }
    assert.equal(await app.prisma.aiGeneration.count({ where: { status: 'ERROR', kind: 'LISTING' } }), cases.length);
  });

  it('timeout: a stalled Claude call becomes a clean 504 and nothing is saved', async () => {
    queue.push({ status: 200, body: {}, hang: true });
    const res = await analyze();
    assert.equal(res.statusCode, 504);
    assert.equal(JSON.parse(res.body).error.code, 'ai_timeout');
    await nothingSaved();
    assert.equal((await app.prisma.aiGeneration.findFirstOrThrow()).errorCode, 'ai_timeout');
  });

  it('invalid structured output twice: 502, nothing saved, both attempts audited', async () => {
    queue.push({ status: 200, body: message('Here is your listing: {not json') });
    queue.push({ status: 200, body: message(JSON.stringify({ ...candleListing, category: 'Weapons' })) });
    const res = await analyze();
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error.code, 'ai_invalid_output');
    await nothingSaved();
    assert.equal(await app.prisma.aiGeneration.count({ where: { status: 'INVALID_OUTPUT', kind: 'LISTING' } }), 2);
  });

  it('missing required fields (no title / no description) are rejected, not saved', async () => {
    const { title: _t, description: _d, ...partial } = candleListing;
    queue.push({ status: 200, body: message(JSON.stringify(partial)) }, { status: 200, body: message(JSON.stringify(partial)) });
    const res = await analyze();
    assert.equal(res.statusCode, 502);
    await nothingSaved();
  });

  it('invalid output once, then valid: the retry succeeds and a single product is saved', async () => {
    queue.push({ status: 200, body: message('oops') });
    queue.push({ status: 200, body: message(JSON.stringify(candleListing)) });
    const res = await analyze();
    assert.equal(res.statusCode, 201);
    assert.equal(await app.prisma.product.count(), 1);
    assert.equal(filesUnder().length, 1);
    assert.deepEqual((await app.prisma.aiGeneration.findMany({ orderBy: { createdAt: 'asc' } })).map((g) => g.status), ['INVALID_OUTPUT', 'SUCCESS']);
  });

  it('a model refusal is a friendly 422 and saves nothing', async () => {
    queue.push({ status: 200, body: message('', { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }) });
    const res = await analyze();
    assert.equal(res.statusCode, 422);
    await nothingSaved();
  });

  it('Claude inventing facts (via the real client): corrective retry, then clean draft saved', async () => {
    queue.push({ status: 200, body: message(JSON.stringify({ ...candleListing, description: 'A handmade soy candle, 200 g, perfect and premium.' })) });
    queue.push({ status: 200, body: message(JSON.stringify(candleListing)) });
    const res = await analyze();
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(received.length, 2);
    const feedback = received[1].messages[0].content.at(-1).text as string;
    assert.ok(/handmade/.test(feedback) && /200 g/.test(feedback) && /premium/.test(feedback), feedback);
    assert.ok(!/handmade|soy|premium/i.test(JSON.parse(res.body).product.description));
  });
});
