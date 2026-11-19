import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { makeApp, postContact, resetDb, validContact } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);

const originalFetch = globalThis.fetch;
const requests: { url: string; body: Record<string, unknown> }[] = [];

let gatewayStatus = 200;
let gatewayResponse: { success: boolean; messageId?: string; error?: string } = {
  success: true,
  messageId: 'gateway-test-id',
};
let app: FastifyInstance;

before(async () => {
  await resetDb();

  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });

    return new Response(JSON.stringify(gatewayResponse), {
      status: gatewayStatus,
      headers: { 'content-type': 'application/json' },
    });
  };

  ({ app } = await makeApp({ CONTACT_TO: 'owner@gharse.test' }));
});

beforeEach(() => {
  requests.length = 0;
  gatewayStatus = 200;
  gatewayResponse = { success: true, messageId: 'gateway-test-id' };
});

after(async () => {
  await app.close();
  globalThis.fetch = originalFetch;
});

describe('contact form through GoDaddy email gateway', () => {
  it('sends the message to the configured recipient with visitor Reply-To', async () => {
    const res = await postContact(app, validContact);

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res), { sent: true });
    assert.equal(requests.length, 1);

    const request = requests[0];
    assert.equal(request.url, 'http://127.0.0.1:2525/api/email/send');

    const payload = request.body;
    assert.deepEqual(payload.to, ['owner@gharse.test']);
    assert.equal(payload.subject, '[GharSe contact] Question about selling on GharSe');
    assert.equal(payload.replyTo, 'asha@example.com');
    assert.equal(payload.from, undefined, 'GoDaddy chooses the sender identity');

    const text = String(payload.text);
    for (const piece of ['Asha Rao', 'asha@example.com', 'crochet bags']) {
      assert.ok(text.includes(piece), `the email contains "${piece}"`);
    }
  });

  it('reports email configured without sending a test email during health checks', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });

    assert.equal(res.statusCode, 200);
    assert.equal(json(res).checks.email, 'configured');
    assert.equal(requests.length, 0);
  });

  it('rejects header injection without contacting the gateway', async () => {
    const res = await postContact(app, {
      ...validContact,
      subject: 'Hello\r\nBcc: evil@example.com',
    });

    assert.equal(res.statusCode, 400);
    assert.equal(requests.length, 0);
  });

  it('returns 502 when the gateway rejects delivery without leaking its details', async () => {
    gatewayStatus = 503;
    gatewayResponse = {
      success: false,
      error: 'private gateway detail owner@gharse.test',
    };

    const res = await postContact(app, validContact);

    assert.equal(res.statusCode, 502);
    assert.equal(json(res).error.code, 'contact_failed');

    for (const secret of [
      'private gateway detail',
      'owner@gharse.test',
      'gateway-test-id',
    ]) {
      assert.ok(!res.body.includes(secret), `response must not contain "${secret}"`);
    }

    assert.equal(requests.length, 1);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/health' })).statusCode,
      200,
    );
  });
});
