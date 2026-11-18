import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildContactEmail, contactSchema } from '../src/modules/contact/routes';
import { errorLogPayload } from '../src/plugins/errors';
import { fakeMailer, makeAppWithMailer, postContact, resetDb, validContact } from './helpers';

const json = (res: { body: string }) => JSON.parse(res.body);
const apps: FastifyInstance[] = [];
async function appWith(mailer: ReturnType<typeof fakeMailer>['mailer'] | null, overrides: Record<string, string> = {}, beforeReady?: (a: FastifyInstance) => void) {
  const { app } = await makeAppWithMailer(mailer, overrides, beforeReady);
  apps.push(app);
  return app;
}
beforeEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  await resetDb();
});
after(async () => {
  for (const a of apps.splice(0)) await a.close();
});

describe('delivery success', () => {
  it('emails the owner through the mailer and only then reports sent', async () => {
    const m = fakeMailer();
    const app = await appWith(m.mailer);
    const res = await postContact(app, validContact);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(json(res), { sent: true });
    assert.equal(m.sent.length, 1, 'exactly one email');
    const mail = m.sent[0];
    assert.equal(mail.subject, '[GharSe contact] Question about selling on GharSe');
    assert.equal(mail.replyTo, 'asha@example.com', 'replying answers the visitor');
    for (const piece of ['Asha Rao', 'asha@example.com', 'Question about selling on GharSe', validContact.message]) {
      assert.ok(mail.text.includes(piece), `the email body contains "${piece}"`);
    }
  });

  it('trims input, keeps line breaks in the message, and accepts boundary lengths', async () => {
    const m = fakeMailer();
    const app = await appWith(m.mailer);
    const res = await postContact(app, { ...validContact, name: '  Asha Rao  ', email: '  asha@example.com ', subject: '  Hello there  ', message: '  Line one is here.\nLine two follows.\n\tIndented.  ' });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(m.sent[0].replyTo, 'asha@example.com');
    assert.ok(m.sent[0].text.includes('Name:    Asha Rao\n'), 'name trimmed');
    assert.ok(m.sent[0].text.includes('Line one is here.\nLine two follows.\n\tIndented.'), 'line breaks and tabs preserved');
    assert.equal((await postContact(app, { ...validContact, name: 'Ab', subject: 'abc', message: 'x'.repeat(10) })).statusCode, 200, 'minimums');
    assert.equal((await postContact(app, { ...validContact, name: 'N'.repeat(80), subject: 'S'.repeat(120), message: 'm'.repeat(2000) })).statusCode, 200, 'maximums');
    assert.equal(m.sent.length, 3);
  });

  it('never leaks recipient or SMTP configuration to the browser', async () => {
    const m = fakeMailer();
    const app = await appWith(m.mailer, { SMTP_HOST: 'smtp.secret-host.test', MAIL_FROM: 'noreply@secret-sender.test', CONTACT_TO: 'owner-inbox@secret-recipient.test', SMTP_USER: 'u', SMTP_PASS: 'p' });
    const responses = [await postContact(app, validContact), await postContact(app, { ...validContact, email: 'bad' })];
    for (const r of responses) {
      for (const secret of ['secret-host', 'secret-sender', 'secret-recipient', 'owner-inbox', 'smtp']) {
        assert.ok(!r.body.toLowerCase().includes(secret), `response must not contain "${secret}"`);
      }
    }
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    assert.ok(!health.body.includes('secret-recipient') && !health.body.includes('owner-inbox'), 'health does not reveal the recipient either');
  });

  it('formats the email as plain text with the reply address as the visitor', () => {
    const mail = buildContactEmail(contactSchema.parse(validContact), new Date('2026-11-18T10:00:00Z'));
    assert.match(mail.text, /Sent:\s+2026-11-18T10:00:00.000Z/);
    assert.equal(mail.replyTo, 'asha@example.com');
  });
});

describe('validation (nothing is emailed for an invalid request)', () => {
  const bad: [string, Record<string, unknown>, string][] = [
    ['missing name', { name: undefined }, 'name'],
    ['one-letter name', { name: 'A' }, 'name'],
    ['name too long', { name: 'A'.repeat(81) }, 'name'],
    ['name with a line break', { name: 'Asha\nBcc: evil@example.com' }, 'name'],
    ['name with a NUL byte', { name: 'Asha\u0000Rao' }, 'name'],
    ['missing email', { email: undefined }, 'email'],
    ['email without @', { email: 'asha.example.com' }, 'email'],
    ['email without a domain', { email: 'asha@' }, 'email'],
    ['email with spaces inside', { email: 'as ha@example.com' }, 'email'],
    ['two addresses', { email: 'a@example.com, b@example.com' }, 'email'],
    ['email with header injection', { email: 'asha@example.com\r\nBcc: evil@example.com' }, 'email'],
    ['email too long', { email: `${'a'.repeat(250)}@example.com` }, 'email'],
    ['subject too short', { subject: 'Hi' }, 'subject'],
    ['subject too long', { subject: 'S'.repeat(121) }, 'subject'],
    ['subject header injection', { subject: 'Hello\r\nBcc: evil@example.com' }, 'subject'],
    ['subject with a line feed', { subject: 'Hello\nthere friend' }, 'subject'],
    ['message too short', { message: 'too short' }, 'message'],
    ['message too long', { message: 'm'.repeat(2001) }, 'message'],
    ['message with a NUL byte', { message: `${validContact.message}\u0000` }, 'message'],
    ['message only spaces', { message: ' '.repeat(30) }, 'message'],
    ['name as a number', { name: 12345 }, 'name'],
    ['message as an array', { message: ['a long enough message', 'x'] }, 'message'],
    ['unknown field', { admin: true }, ''],
    ['recipient override attempt', { to: 'evil@example.com' }, ''],
    ['cc attempt', { cc: 'evil@example.com' }, ''],
  ];
  for (const [name, over, field] of bad) {
    it(`rejects: ${name}`, async () => {
      const m = fakeMailer();
      const app = await appWith(m.mailer);
      const res = await postContact(app, { ...validContact, ...over });
      assert.equal(res.statusCode, 400, `${name}: ${res.body.slice(0, 200)}`);
      assert.equal(json(res).error.code, 'validation_error');
      if (field) assert.ok(json(res).error.fields[field], `${name}: expected a message for "${field}", got ${JSON.stringify(json(res).error.fields)}`);
      assert.equal(m.sent.length, 0, 'nothing was emailed');
    });
  }

  it('rejects bodies that are not JSON objects', async () => {
    const m = fakeMailer();
    const app = await appWith(m.mailer);
    for (const body of ['plain text', '[]', 'null', '12']) {
      const res = await app.inject({ method: 'POST', url: '/api/contact', headers: { 'content-type': 'application/json' }, payload: body });
      assert.ok([400, 415].includes(res.statusCode), `"${body}" must be refused (got ${res.statusCode})`);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/contact', payload: 'name=x&message=y', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).statusCode, 415);
    assert.equal(m.sent.length, 0);
  });

  it('refuses oversized requests before they are processed', async () => {
    const m = fakeMailer();
    const app = await appWith(m.mailer);
    const res = await postContact(app, { ...validContact, message: 'x'.repeat(50_000) });
    assert.equal(res.statusCode, 413, `got ${res.statusCode}`);
    assert.equal(m.sent.length, 0);
  });
});

describe('abuse protection', () => {
  it('honeypot: a filled hidden field is refused, nothing is emailed, and it never claims sent', async () => {
    const m = fakeMailer();
    const app = await appWith(m.mailer);
    const res = await postContact(app, { ...validContact, website: 'http://spam.example' });
    assert.equal(res.statusCode, 400);
    assert.ok(!res.body.includes('"sent"'), 'no "sent" claim');
    assert.equal(m.sent.length, 0);
    assert.equal((await postContact(app, { ...validContact, website: '' })).statusCode, 200, 'an empty honeypot is fine');
    assert.equal((await postContact(app, validContact)).statusCode, 200, 'an absent honeypot is fine');
  });

  it('rate limits per client IP: the extra requests get 429 and no email', async () => {
    const m = fakeMailer();
    const app = await appWith(m.mailer, { CONTACT_RATE_LIMIT_MAX: '2' });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await postContact(app, validContact)).statusCode);
    assert.deepEqual(codes, [200, 200, 429, 429]);
    assert.equal(json(await postContact(app, validContact)).error.code, 'rate_limited');
    assert.equal(m.sent.length, 2, 'only the allowed messages were emailed');
    assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200, 'the rest of the site is unaffected');
  });

  it('TRUST_PROXY=false (default): forged X-Forwarded-For addresses do not evade the limit', async () => {
    const m = fakeMailer();
    const app = await appWith(m.mailer, { CONTACT_RATE_LIMIT_MAX: '2', TRUST_PROXY: 'false' });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await postContact(app, validContact, { 'x-forwarded-for': `203.0.113.${i + 1}` })).statusCode);
    assert.deepEqual(codes, [200, 200, 429, 429]);
  });

  it('TRUST_PROXY=true: different visitors behind the proxy are limited separately', async () => {
    const m = fakeMailer();
    const app = await appWith(m.mailer, { CONTACT_RATE_LIMIT_MAX: '2', TRUST_PROXY: 'true' });
    const distinct: number[] = [];
    for (let i = 0; i < 3; i++) distinct.push((await postContact(app, validContact, { 'x-forwarded-for': `203.0.113.${i + 1}` })).statusCode);
    assert.deepEqual(distinct, [200, 200, 200]);
    const same: number[] = [];
    for (let i = 0; i < 3; i++) same.push((await postContact(app, validContact, { 'x-forwarded-for': '198.51.100.7' })).statusCode);
    assert.deepEqual(same, [200, 200, 429]);
  });

  it('has an hourly cap across ALL visitors so a flood cannot fill the mailbox', async () => {
    const m = fakeMailer();
    const app = await appWith(m.mailer, { CONTACT_HOURLY_LIMIT: '3', TRUST_PROXY: 'true' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await postContact(app, validContact, { 'x-forwarded-for': `203.0.113.${i + 1}` })).statusCode);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.equal(json(await postContact(app, validContact, { 'x-forwarded-for': '203.0.113.99' })).error.code, 'contact_busy');
    assert.equal(m.sent.length, 3);
  });

  it('blocks cross-site browser posts (existing origin check applies)', async () => {
    const m = fakeMailer();
    const app = await appWith(m.mailer);
    const res = await postContact(app, validContact, { origin: 'https://evil.example' });
    assert.equal(res.statusCode, 403);
    assert.equal(m.sent.length, 0);
  });

  it('invalid requests do not consume the global mailbox cap', async () => {
    const m = fakeMailer();
    const app = await appWith(m.mailer, { CONTACT_HOURLY_LIMIT: '2' });
    for (let i = 0; i < 5; i++) await postContact(app, { ...validContact, email: 'nope' });
    assert.equal((await postContact(app, validContact)).statusCode, 200);
    assert.equal((await postContact(app, validContact)).statusCode, 200);
  });
});

describe('delivery failure and missing configuration (fail safely, never claim sent)', () => {
  it('mail not configured: 503, vague message, nothing claimed or revealed', async () => {
    const app = await appWith(null);
    const res = await postContact(app, validContact);
    assert.equal(res.statusCode, 503);
    assert.equal(json(res).error.code, 'contact_unavailable');
    assert.ok(!res.body.includes('"sent"'), 'no "sent" claim');
    for (const hint of ['SMTP', 'CONTACT_TO', 'MAIL_FROM', 'configured', 'env']) assert.ok(!res.body.includes(hint), `must not hint at "${hint}"`);
    // validation still runs first, so bad input is a 400 even when mail is down
    assert.equal((await postContact(app, { ...validContact, email: 'bad' })).statusCode, 400);
  });

  it('mail server rejects the message: 502, no "sent", and no server details in the response', async () => {
    const m = fakeMailer({ fail: Object.assign(new Error('550 5.1.1 <owner@secret-recipient.test> mailbox unavailable via smtp.secret-host.test'), { code: 'EENVELOPE' }) });
    const app = await appWith(m.mailer);
    const res = await postContact(app, validContact);
    assert.equal(res.statusCode, 502);
    assert.equal(json(res).error.code, 'contact_failed');
    assert.ok(!res.body.includes('"sent"'), 'no "sent" claim');
    for (const leak of ['550', 'secret-recipient', 'secret-host', 'mailbox unavailable', 'owner@']) assert.ok(!res.body.includes(leak), `response must not contain "${leak}"`);
  });

  it('mail server hangs: gives up after the configured timeout with a 502', async () => {
    const m = fakeMailer({ hang: true });
    const app = await appWith(m.mailer, { CONTACT_SEND_TIMEOUT_MS: '1000' });
    const started = Date.now();
    const res = await postContact(app, validContact);
    assert.equal(res.statusCode, 502);
    assert.equal(json(res).error.code, 'contact_failed');
    const took = Date.now() - started;
    assert.ok(took >= 900 && took < 5000, `returned after the timeout (${took} ms)`);
  });

  it('a failure does not poison later requests', async () => {
    let fail = true;
    const sent: unknown[] = [];
    const app = await appWith({
      async verify() {},
      async send(m) {
        if (fail) throw new Error('temporary outage');
        sent.push(m);
      },
    });
    assert.equal((await postContact(app, validContact)).statusCode, 502);
    fail = false;
    assert.equal((await postContact(app, validContact)).statusCode, 200);
    assert.equal(sent.length, 1);
  });
});

describe('privacy: no personal data in logs', () => {
  it('error log payloads for the contact route carry only the error class and code', () => {
    const err = Object.assign(new Error('550 <victim@example.com> rejected message: "Hello, my phone is 9876543210"'), { code: 'EENVELOPE', name: 'Error' });
    const safe = JSON.stringify(errorLogPayload(err, 'POST', '/api/contact'));
    for (const pii of ['victim', '9876543210', 'rejected', 'Hello']) assert.ok(!safe.includes(pii), `log payload must not include ${pii}`);
    assert.match(safe, /EENVELOPE/);
    assert.equal((errorLogPayload(err, 'GET', '/api/health') as { err?: unknown }).err, err, 'other routes keep full logging');
  });

  it('delivery failures, successes and rejections write nothing personal to any log', async () => {
    const logged: string[] = [];
    const capture = (a: FastifyInstance) =>
      a.addHook('onRequest', async (req) => {
        for (const level of ['error', 'warn', 'info', 'debug'] as const) {
          const orig = req.log[level].bind(req.log) as (...x: unknown[]) => void;
          (req.log as unknown as Record<string, unknown>)[level] = (...args: unknown[]) => {
            // Serialise like pino's default serializers: req -> method/url, res -> status, errors -> name/message/stack.
            logged.push(
              JSON.stringify(args, (k, v) => {
                if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
                if ((k === 'req' || k === 'res') && v && typeof v === 'object') return { method: (v as { method?: string }).method, url: (v as { url?: string }).url, statusCode: (v as { statusCode?: number }).statusCode };
                return v;
              }),
            );
            return orig(...args);
          };
        }
      });
    const personal = { name: 'Priyanka Venkataraman', email: 'priyanka.v@private-example.org', subject: 'Private question about my account', message: 'My phone number is 9812345670 and my address is 22 Hidden Lane.' };
    const failing = await appWith(fakeMailer({ fail: new Error(`550 rejected <priyanka.v@private-example.org> ${personal.message}`) }).mailer, {}, capture);
    assert.equal((await postContact(failing, personal)).statusCode, 502);
    const unconfigured = await appWith(null, {}, capture);
    assert.equal((await postContact(unconfigured, personal)).statusCode, 503);
    assert.equal((await postContact(unconfigured, { ...personal, email: 'bad' })).statusCode, 400);
    const ok = await appWith(fakeMailer().mailer, {}, capture);
    assert.equal((await postContact(ok, personal)).statusCode, 200);
    assert.equal((await postContact(ok, { ...personal, website: 'x' })).statusCode, 400);
    assert.ok(logged.length >= 1, 'the failures were logged');
    const all = logged.join('\n');
    for (const pii of ['Priyanka', 'priyanka.v', 'private-example', '9812345670', 'Hidden Lane', 'Private question']) {
      assert.ok(!all.includes(pii), `logs must not contain "${pii}"`);
    }
  });
});
