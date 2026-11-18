import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { makeApp, postContact, resetDb, validContact } from './helpers';
import { startSmtpSink } from './smtpSink';

// The REAL mailer (nodemailer, unmodified) talking SMTP to a local sink. No external service, account or credentials.
// The addresses below are fake test values, not a suggestion for production configuration.
const json = (res: { body: string }) => JSON.parse(res.body);
let sink: Awaited<ReturnType<typeof startSmtpSink>>;
let app: FastifyInstance;

before(async () => {
  await resetDb();
  sink = await startSmtpSink();
  ({ app } = await makeApp({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.port), SMTP_SECURE: 'false', MAIL_FROM: 'GharSe Contact <no-reply@gharse.test>', CONTACT_TO: 'owner@gharse.test' }));
});
after(async () => {
  await app.close();
  await sink.close();
});

describe('contact form through the real mailer and a real SMTP conversation', () => {
  it('delivers the message to CONTACT_TO from MAIL_FROM with a Reply-To of the visitor', async () => {
    const res = await postContact(app, validContact);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res), { sent: true });
    assert.equal(sink.messages.length, 1, 'the SMTP server received exactly one message');
    const m = sink.messages[0];
    assert.deepEqual(m.to, ['<owner@gharse.test>']);
    assert.equal(m.from, 'FROM:<no-reply@gharse.test>'.replace('FROM:', ''), 'envelope sender');
    assert.match(m.data, /^Subject: \[GharSe contact\] Question about selling on GharSe$/m);
    assert.match(m.data, /^Reply-To: asha@example\.com$/m);
    assert.match(m.data, /^To: owner@gharse\.test$/m);
    for (const piece of ['Asha Rao', 'asha@example.com', 'crochet bags']) assert.ok(m.data.includes(piece), `the delivered email contains "${piece}"`);
  });

  it('health reports email ok when the SMTP server is reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(json(res).checks.email, 'ok');
  });

  it('a header-injection attempt cannot add recipients (rejected before the mailer; nothing delivered)', async () => {
    const before = sink.messages.length;
    const res = await postContact(app, { ...validContact, subject: 'Hello\r\nBcc: evil@example.com' });
    assert.equal(res.statusCode, 400);
    assert.equal(sink.messages.length, before);
    for (const m of sink.messages) assert.ok(!/evil@example\.com/.test(m.data), 'no message ever mentions an injected recipient');
  });

  it('when the SMTP server is down: 502 contact_failed, no "sent", and no connection details leaked', async () => {
    const dead = await startSmtpSink();
    const port = dead.port;
    await dead.close();
    const { app: broken } = await makeApp({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), MAIL_FROM: 'no-reply@gharse.test', CONTACT_TO: 'owner@gharse.test' });
    const res = await postContact(broken, validContact);
    assert.equal(res.statusCode, 502);
    assert.equal(json(res).error.code, 'contact_failed');
    for (const leak of ['ECONNREFUSED', '127.0.0.1', String(port), 'owner@gharse.test', '"sent"']) assert.ok(!res.body.includes(leak), `response must not contain "${leak}"`);
    assert.equal((await broken.inject({ method: 'GET', url: '/api/health' })).statusCode, 200, 'an email outage does not take the site down');
    assert.equal(json(await broken.inject({ method: 'GET', url: '/api/health' })).checks.email, 'fail');
    await broken.close();
  });
});
