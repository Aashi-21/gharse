import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { cannedBrand, makeApp, resetDb, sellerWithStore } from './helpers';

// A local stand-in for api.anthropic.com so the REAL client wrapper (retries, error mapping,
// usage logging, request shape) is exercised without a key or network.
type Reply = { status: number; headers?: Record<string, string>; body: unknown };
let server: http.Server;
let queue: Reply[] = [];
let received: any[] = [];

const message = (text: string, extra: object = {}) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 321, output_tokens: 123 }, ...extra,
});

let app: FastifyInstance;
let cookie: string;
const brief = { productsMade: 'Hand-poured soy candles', audience: 'Young professionals', preferredName: '', personality: 'calm' };
const generate = () => app.inject({ method: 'POST', url: '/api/seller/brand/generate', headers: { cookie }, payload: brief });

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body: JSON.parse(raw || '{}') });
      const r = queue.shift() ?? { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'queue empty' } } };
      res.writeHead(r.status, { 'content-type': 'application/json', 'x-should-retry': 'false', ...r.headers });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ({ app } = await makeApp({ ANTHROPIC_API_KEY: 'sk-test-not-real' }));
});
after(async () => {
  await app.close();
  server.close();
  delete process.env.ANTHROPIC_BASE_URL;
});
beforeEach(async () => {
  await resetDb();
  queue = [];
  received = [];
  cookie = await sellerWithStore(app, 'a@example.com', 'a-store');
});

describe('real Claude client wrapper (against a local fake API)', () => {
  it('sends the right request, parses the answer, and logs model + token usage', async () => {
    queue.push({ status: 200, body: message(JSON.stringify(cannedBrand)) });
    const res = await generate();
    assert.equal(res.statusCode, 200);

    const sent = received[0];
    assert.equal(sent.url, '/v1/messages');
    assert.equal(sent.headers.authorization, 'Bearer sk-test-not-real');
    assert.equal(sent.body.model, 'claude-sonnet-5-5');
    assert.equal(sent.body.output_config.format.type, 'json_schema');
    assert.equal(sent.body.output_config.effort, 'medium');
    assert.ok(sent.body.output_config.format.schema.properties.tagline);
    assert.equal(sent.body.tool_choice, undefined); // forced tool use is rejected by this model
    assert.equal(sent.body.temperature, undefined);
    assert.match(sent.body.messages[0].content, /Hand-poured soy candles/);

    const rows = await app.prisma.aiGeneration.findMany();
    assert.equal(rows.length, 1);
    assert.deepEqual(
      { kind: rows[0].kind, model: rows[0].model, status: rows[0].status, inputTokens: rows[0].inputTokens, outputTokens: rows[0].outputTokens },
      { kind: 'BRAND', model: 'claude-sonnet-5-5', status: 'SUCCESS', inputTokens: 321, outputTokens: 123 },
    );
    assert.ok(rows[0].latencyMs! >= 0);
  });

  it('retries once on malformed output, then succeeds', async () => {
    queue.push({ status: 200, body: message('Sure! Here is your brand: {oops') });
    queue.push({ status: 200, body: message(JSON.stringify(cannedBrand)) });
    const res = await generate();
    assert.equal(res.statusCode, 200);
    assert.equal(received.length, 2);
    const statuses = (await app.prisma.aiGeneration.findMany({ orderBy: { createdAt: 'asc' } })).map((r) => r.status);
    assert.deepEqual(statuses, ['INVALID_OUTPUT', 'SUCCESS']);
  });

  it('fails cleanly after two invalid answers (schema violation, missing fields)', async () => {
    queue.push({ status: 200, body: message(JSON.stringify({ name: 'Only a name' })) });
    queue.push({ status: 200, body: message(JSON.stringify({ ...cannedBrand, primaryColor: 'red' })) });
    const res = await generate();
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error.code, 'ai_invalid_output');
    assert.equal(await app.prisma.aiGeneration.count({ where: { status: 'INVALID_OUTPUT' } }), 2);
  });

  it('treats a truncated (max_tokens) answer as invalid, not as success', async () => {
    const truncated = message(JSON.stringify(cannedBrand), { stop_reason: 'max_tokens' });
    queue.push({ status: 200, body: truncated }, { status: 200, body: truncated });
    const res = await generate();
    assert.equal(res.statusCode, 502);
    assert.equal((await app.prisma.aiGeneration.findFirstOrThrow()).errorCode, 'max_tokens');
  });

  it('maps API failures to safe, specific errors and logs them', async () => {
    const cases: [Reply, number, string][] = [
      [{ status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'secret internal detail' } } }, 429, 'ai_busy'],
      [{ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'x' } } }, 502, 'ai_unavailable'],
      [{ status: 500, body: { type: 'error', error: { type: 'api_error', message: 'x' } } }, 502, 'ai_unavailable'],
      [{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key sk-test-not-real' } } }, 503, 'ai_not_configured'],
      [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } }, 502, 'ai_request_failed'],
    ];
    for (const [reply, status, code] of cases) {
      queue.push(reply);
      const res = await generate();
      assert.equal(res.statusCode, status, code);
      assert.equal(JSON.parse(res.body).error.code, code);
      assert.ok(!res.body.includes('secret internal detail') && !res.body.includes('sk-test'), 'no upstream details leak');
    }
    const rows = await app.prisma.aiGeneration.findMany({ where: { status: 'ERROR' } });
    assert.equal(rows.length, cases.length);
    assert.deepEqual(rows.map((r) => r.errorCode).sort(), cases.map((c) => c[2]).sort());
  });

  it('surfaces a model refusal as a friendly 422', async () => {
    queue.push({ status: 200, body: message('', { stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: null, explanation: null } }) });
    const res = await generate();
    assert.equal(res.statusCode, 422);
    assert.equal(JSON.parse(res.body).error.code, 'ai_refused');
  });
});
