import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Prisma } from '@prisma/client';
import { loadConfig } from '../src/config';
import {
  describeHealthFailure,
  HealthTimeoutError,
  healthFailureMessage,
  healthLogSecrets,
  sanitizeDetail,
  secretsFromUrl,
} from '../src/modules/health/diagnose';

// A made-up Neon-style URL. None of these values is real.
const HOST = 'ep-cool-darkness-123456.eu-central-1.aws.neon.tech';
const USER = 'neondb_owner';
const PASSWORD = 'Sup3r/Secret!';
const DB = 'neondb';
const URL = `postgresql://${USER}:${encodeURIComponent(PASSWORD)}@${HOST}/${DB}?sslmode=require`;
const secrets = secretsFromUrl(URL);

/** Every piece of the connection details that must never appear. */
const FORBIDDEN = [URL, HOST, USER, PASSWORD, encodeURIComponent(PASSWORD), DB, '203.0.113.7', 'ep-cool-darkness'];
const leaks = (text: string, values: string[] = FORBIDDEN) => values.filter((v) => text.toLowerCase().includes(v.toLowerCase()));
const run = (err: unknown, ms = 42) => describeHealthFailure('database', err, secrets, ms);
const lowerHex = (s: string) => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('health failure diagnostics: what is logged', () => {
  it('Prisma "cannot reach database": class, code and the message line, with the host masked', () => {
    const err = new Prisma.PrismaClientInitializationError(
      `Can't reach database server at \`${HOST}:5432\`\n\nPlease make sure your database server is running at \`${HOST}:5432\`.`,
      '6.19.3',
      'P1001',
    );
    const f = run(err);
    assert.equal(f.errName, 'PrismaClientInitializationError');
    assert.equal(f.errCode, 'P1001');
    assert.equal(f.timeout, false);
    assert.match(f.detail, /^Can't reach database server at /);
    assert.deepEqual(leaks(JSON.stringify(f) + healthFailureMessage(f)), [], 'no connection detail in the fields or in the message');
  });

  it('Prisma known-request error: skips the "Invalid ... invocation" header and reads the real message', () => {
    const err = new Prisma.PrismaClientKnownRequestError(
      `\nInvalid \`prisma.$queryRaw()\` invocation:\n\n\nPassword authentication failed for user \`${USER}\``,
      { code: 'P1000', clientVersion: '6.19.3' },
    );
    const f = run(err);
    assert.equal(f.errCode, 'P1000');
    assert.match(f.detail, /^Password authentication failed for user/);
    assert.deepEqual(leaks(f.detail), []);
  });

  it('plain Node errors keep their code (for example ECONNREFUSED) and mask addresses', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 203.0.113.7:5432'), { code: 'ECONNREFUSED' });
    const f = run(err);
    assert.equal(f.errName, 'Error');
    assert.equal(f.errCode, 'ECONNREFUSED');
    assert.match(f.detail, /connect ECONNREFUSED <ip>/);
    assert.deepEqual(leaks(f.detail), []);
  });

  it('reports whether the 5 second guard fired, and only for our own timeout', () => {
    const t = run(new HealthTimeoutError(), 5001);
    assert.equal(t.timeout, true);
    assert.equal(t.errName, 'HealthTimeoutError');
    assert.equal(t.detail, 'timeout');
    assert.equal(t.ms, 5001);
    assert.equal(healthFailureMessage(t).includes('timeout=true'), true);
    // a different error that merely says "timeout" is not mistaken for the guard
    const other = run(new Error('timeout'));
    assert.equal(other.timeout, false);
    assert.equal(healthFailureMessage(other).includes('timeout=false'), true);
    assert.equal(new HealthTimeoutError().message, 'timeout', 'the guard still rejects with the same message as before');
  });

  it('the log message is one line in a fixed format', () => {
    const f = run(new Prisma.PrismaClientInitializationError(`Can't reach database server at \`${HOST}:5432\``, '6.19.3', 'P1001'), 1234);
    const msg = healthFailureMessage(f);
    assert.match(msg, /^health check failed \[database\] name=PrismaClientInitializationError code=P1001 timeout=false ms=1234 detail="[^\n]*"$/);
  });
});

describe('health failure diagnostics: sanitization', () => {
  it('removes the whole URL, and each part of it, in raw and encoded form', () => {
    const text = `bad string ${URL} / host ${HOST} / user ${USER} / pw ${PASSWORD} / enc ${encodeURIComponent(PASSWORD)} / db ${DB} / ip 203.0.113.7:5432`;
    const out = sanitizeDetail(text, secrets);
    assert.deepEqual(leaks(out), [], out);
  });

  it('collapses a whole connection string into a single marker', () => {
    assert.equal(sanitizeDetail(`bad string ${URL} end`, secrets), 'bad string <redacted> end');
  });

  it('masks hosts case-insensitively and hosts it was not told about', () => {
    assert.deepEqual(leaks(sanitizeDetail(`at ${HOST.toUpperCase()}:5432`, secrets)), []);
    const unknown = sanitizeDetail('resolved other-host.eu-west-2.compute.amazonaws.com:5432 and 2001:db8:85a3:0:0:8a2e:370:7334', secrets);
    assert.ok(!/amazonaws|2001:db8/.test(unknown), unknown);
  });

  it('still works when DATABASE_URL is malformed: every piece of it is treated as sensitive', () => {
    const bad = 'postgresql://user name:p@ss word@host name/db?x=y z';
    const s = secretsFromUrl(bad);
    const out = sanitizeDetail('error near p@ss and word and host name db', s);
    assert.ok(!/p@ss|word|host/.test(out), out);
  });

  it('keeps useful non-identifying text (TLS, timeout and engine messages)', () => {
    assert.equal(sanitizeDetail('Error opening a TLS connection: no TLS support', secrets), 'Error opening a TLS connection: no TLS support');
    assert.match(sanitizeDetail('Timed out fetching a new connection from the connection pool', secrets), /Timed out fetching a new connection/);
    assert.match(sanitizeDetail('Query engine library for current platform "debian-openssl-3.0.x" could not be found', secrets), /debian-openssl-3\.0\.x/);
  });

  it('is single-line, strips control characters and caps the length', () => {
    const out = sanitizeDetail(`a\u0000b\r\nc\u001b[31md ${'x'.repeat(500)}`, secrets);
    assert.ok(!/[\u0000-\u001f]/.test(out), 'no control characters');
    assert.ok(out.length <= 203, `capped (${out.length})`);
  });

  it('handles values that are not Error objects, and hostile names or codes', () => {
    for (const weird of [undefined, null, 'just a string', 42, {}, { name: 'x\ny', code: 'bad code!', message: 7 }, { name: 'A'.repeat(500), code: 'P'.repeat(80) }]) {
      const f = run(weird);
      assert.equal(f.errName, 'UnknownError');
      assert.equal(f.errCode, undefined);
      assert.equal(f.timeout, false);
      assert.equal(f.detail, '');
    }
  });
});

describe('health failure diagnostics: IPv6 addresses', () => {
  const MASKED: [string, string][] = [
    ['loopback, as Node prints it with a port', 'connect ECONNREFUSED ::1:5432'],
    ['loopback alone', 'connect ECONNREFUSED ::1'],
    ['compressed documentation address', 'connect ETIMEDOUT 2001:db8::1'],
    ['compressed, upper case', 'connect ETIMEDOUT 2001:DB8::1'],
    ['compressed address that is a valid IPv6 when the port is read as a group', 'connect ETIMEDOUT 2001:db8::1:5432'],
    ['bracketed with a port', 'connect ETIMEDOUT [2001:db8::1]:5432'],
    ['bracketed loopback with a port', 'connect ECONNREFUSED [::1]:5432'],
    ['ending a sentence', 'Server at 2001:db8::1.'],
    ['trailing compression', '2001:db8:: is unreachable'],
    ['in parentheses', 'host (2001:db8::1) refused'],
    ['after an equals sign and in quotes', 'address="2001:db8::1" family=6'],
    ['link-local with a zone id', 'connect EINVAL fe80::1%eth0'],
    ['IPv4-mapped', 'connect ECONNREFUSED ::ffff:192.0.2.1'],
    ['full form', 'peer 2001:db8:85a3:0:0:8a2e:370:7334 closed the connection'],
    ['expanded, with leading zeros', 'peer 2001:0db8:0000:0000:0000:0000:0000:0001 closed'],
    ['expanded link-local', 'peer fe80:0:0:0:0:0:0:1 closed'],
    ['upper-case compressed', 'peer 2001:DB8:85A3::8A2E:370:7334 closed'],
    ['bracketed zone id with a port', 'bind [fe80::1%eth0]:5432'],
    ['IPv4-mapped, hex form', 'connect ::ffff:c000:201 refused'],
    ['IPv4-mapped, bracketed with a port', 'connect [::ffff:192.0.2.1]:5432 refused'],
    ['NAT64 with an embedded IPv4', 'connect 64:ff9b::192.0.2.33 refused'],
    ['with a CIDR suffix', 'allowed 2001:db8::/32'],
    ['in a comma separated list', 'peers 2001:db8::1, 2001:db8::2; done'],
    ['an empty zone id still has its address masked', 'bad fe80::1% here'],
  ];
  for (const [label, text] of MASKED) {
    it(`masks an IPv6 address: ${label}`, () => {
      const out = sanitizeDetail(text, []);
      assert.ok(out.includes('<ip>'), `an address is masked: ${out}`);
      assert.ok(!/::1\b|2001:|db8|fe80|ffff|192\.0\.2/i.test(out), `no address fragment remains: ${out}`);
    });
  }

  it('keeps the sentence around the address readable', () => {
    assert.equal(sanitizeDetail('connect ECONNREFUSED ::1:5432', []), 'connect ECONNREFUSED <ip>');
    assert.equal(sanitizeDetail('Server at 2001:db8::1.', []), 'Server at <ip>.');
    assert.equal(sanitizeDetail('connect ETIMEDOUT [2001:db8::1]:5432', []), 'connect ETIMEDOUT <ip>');
  });

  it('does not mangle text that only looks similar (C++ names, times, error prefixes)', () => {
    for (const text of ['std::string failed', 'Error: connect failed', 'at 12:34:56 UTC', "P1001: Can't reach the server", 'code: ECONNREFUSED', 'Foo::bar::baz threw']) {
      assert.equal(sanitizeDetail(text, []), text);
    }
  });

  it('leaves malformed IPv6-like strings alone (they are not addresses, and nothing may crash)', () => {
    for (const text of [
      'bad 2001:db8:::1 here',
      'bad 12345::1 here',
      'bad gggg::1 here',
      'bad 1:2:3:4:5:6:7:8:9 here',
      'bad 2001:db8::1::2 here',
      'bad :1:2:3 here',
      'bad 2001:db8 here',
      'iface 00:1a:2b:3c:4d:5e up',
      'bad [not:an:ip] here',
      'bad [] and [:] here',
    ]) {
      assert.equal(sanitizeDetail(text, []), text);
    }
  });

  it('leaves the unspecified address "::" alone: it identifies nothing and "::" appears in ordinary names', () => {
    for (const text of ['std::vector<int>::iterator failed', 'listening on :: port 5432', 'Option<T>::None', 'Foo::bar::baz threw']) {
      assert.equal(sanitizeDetail(text, []), text);
    }
    assert.equal(sanitizeDetail('connect ECONNREFUSED ::1', []), 'connect ECONNREFUSED <ip>', 'but the loopback address is still masked');
  });

  it('leaves ordinary text alone: timestamps, stack frames, error codes, digests and JSON', () => {
    for (const text of [
      'at 2026-11-18T08:05:36.908Z the server',
      'started 08:05:36 and 12:34:56.789 UTC',
      'Nov 18 14:22:49 host sshd',
      'at Object.<anonymous> (/app/server/dist/app.js:12:34)',
      'at Module._compile (node:internal/modules/cjs/loader:1554:14)',
      'at async Promise.all (index 0)',
      'P1001 ECONNREFUSED ERR_SSL_WRONG_VERSION_NUMBER 23505 SQLSTATE 08006 28P01',
      'code: ECONNREFUSED, errno: -111',
      'image sha256:abcdef0123456789 pulled',
      '{"a":1,"b":{"c":2},"d":"x:y"}',
      'GET /api/items/12:34 404',
      'ratio 3:1 and key:value',
    ]) {
      assert.equal(sanitizeDetail(text, []), text);
    }
  });

  it('end to end: a loopback IPv6 failure is logged without the address', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED ::1:5432'), { code: 'ECONNREFUSED' });
    const f = run(err);
    assert.equal(f.errCode, 'ECONNREFUSED');
    assert.equal(f.detail, 'connect ECONNREFUSED <ip>');
  });
});

describe('health failure diagnostics: bounded work', () => {
  it('stays fast on very long input that used to be quadratic (dots, no colons)', () => {
    const started = Date.now();
    sanitizeDetail('1.'.repeat(50_000), secrets);
    sanitizeDetail('a'.repeat(100_000), secrets);
    sanitizeDetail('fe80::1%' + 'a'.repeat(100_000), secrets);
    const ms = Date.now() - started;
    assert.ok(ms < 1500, `took ${ms} ms`);
  });

  it('removes secrets from the WHOLE text before it is cut, so a secret cut by the limit cannot leave a fragment', () => {
    // A 1,800 character host name collapses to one short marker, so text near the 2,000 character limit reaches the output.
    const blob = ['a'.repeat(600), 'b'.repeat(600), 'c'.repeat(600)].join('.') + '.com';
    const text = `${blob} ${'y'.repeat(190)} ${PASSWORD} tail`;
    assert.ok(text.indexOf(PASSWORD) < 2000 && text.indexOf(PASSWORD) + PASSWORD.length > 2000, 'the password straddles the 2,000 character limit');
    const out = sanitizeDetail(text, secrets);
    assert.ok(!/Sup3r|Secret/.test(out), `no fragment of the password: ${out}`);
  });

  it('cuts at a space, so an address or host name is never split in two', () => {
    // The long host name collapses to one marker, so what sits at the limit is visible in the output.
    const blob = ['a'.repeat(600), 'b'.repeat(600), 'c'.repeat(600)].join('.') + '.com';
    const text = `${blob} ${'z'.repeat(175)} 2001:db8:85a3:0:0:8a2e:370:7334 tail`;
    assert.ok(text.indexOf('2001:db8') < 2000 && text.indexOf('2001:db8') + 31 > 2000, 'the address straddles the 2,000 character limit');
    const out = sanitizeDetail(text, []);
    assert.ok(!/2001:db8/.test(out), `no half of an address: ${out}`);
  });

  it('short messages are not affected by the limit', () => {
    assert.equal(sanitizeDetail('Timed out fetching a new connection', []), 'Timed out fetching a new connection');
  });
});

describe('health failure diagnostics: credential leakage review', () => {
  // Passwords that stress URL encoding, quoting, unicode and regular-expression characters.
  const PASSWORDS = [
    'Sup3r/Secret!',
    'p@ss:w/rd?#[]',
    'pa ss word',
    `q'uo"te\`s`,
    'ünïcödé-✓-密码',
    'percent%41lit',
    'a+b=c&d',
    '{curly}(paren)*star^caret$dollar|pipe\\back',
    'x'.repeat(64),
  ];

  for (const pw of PASSWORDS) {
    it(`never leaks the password in any form: ${pw.slice(0, 18)}`, () => {
      const url = `postgresql://svc_user:${encodeURIComponent(pw)}@db.internal.example.test:5432/appdb`;
      const s = secretsFromUrl(url);
      const forms = [pw, encodeURIComponent(pw), lowerHex(encodeURIComponent(pw)), b64(pw), url];
      const out = sanitizeDetail(`auth failed: ${forms.join(' | ')}`, s);
      assert.deepEqual(leaks(out, forms), [], out);
      assert.ok(!/svc_user|db\.internal|appdb/i.test(out), `user, host and database are gone too: ${out}`);
    });
  }

  it('masks the longest secret first, so a user name inside the password cannot leave password fragments behind', () => {
    const url = 'postgresql://admin:admin-Secret-99@db.example.test/appdb';
    const out = sanitizeDetail('password admin-Secret-99 rejected for admin', secretsFromUrl(url));
    assert.ok(!/Secret|99/.test(out), `no part of the password remains: ${out}`);
    assert.equal(out, 'password <redacted> rejected for <redacted>');
  });

  it('masks credentials passed as URL query parameters, but keeps harmless parameters readable', () => {
    const url = 'postgresql://u:pw123456@db.example.test/appdb?sslmode=require&sslpassword=KeyPass456&options=-c%20search_path%3Dsecret_schema&connect_timeout=30';
    const out = sanitizeDetail('sslpassword KeyPass456, options -c search_path=secret_schema, TLS required, connect_timeout 30', secretsFromUrl(url));
    assert.ok(!/KeyPass456|secret_schema/.test(out), out);
    assert.ok(out.includes('TLS required') && out.includes('connect_timeout 30'), `harmless text survives: ${out}`);
  });

  it('masks an IPv6 database host in every spelling', () => {
    const url = 'postgresql://u:pw123456@[2001:db8::5]:5432/appdb';
    const out = sanitizeDetail('tried [2001:db8::5]:5432 then 2001:db8::5 then 2001:db8::5:5432', secretsFromUrl(url));
    assert.ok(!/2001:db8/.test(out), out);
  });

  it('masks base64 forms of the credentials (as they appear in SMTP/HTTP auth traces)', () => {
    const url = 'postgresql://svc_user:pw/with/slash@db.example.test/appdb';
    const out = sanitizeDetail(`Basic ${b64('svc_user:pw/with/slash')} / ${b64('pw/with/slash')}`, secretsFromUrl(url));
    assert.ok(!out.includes(b64('pw/with/slash')), out);
  });

  it('is not fooled by regular-expression characters in the secrets themselves', () => {
    const out = sanitizeDetail('value is a.b*c+(d)[e]{f}|g^h$i\\j end', ['a.b*c+(d)[e]{f}|g^h$i\\j']);
    assert.equal(out, 'value is <redacted> end');
  });

  it('documents the one limit: values shorter than 3 characters are not masked (they would blank out ordinary words)', () => {
    assert.equal(sanitizeDetail('the ab value', secretsFromUrl('postgresql://u:ab@host.example.test/db')).includes('ab'), true);
  });
});



describe('health failure diagnostics: configured secrets (database and contact)', () => {
  // Use the real config loader so the test verifies the actual config properties.
  const cfg = loadConfig({
    DATABASE_URL: URL,
    CONTACT_TO: 'owner@gharse.example',
  });
  const list = healthLogSecrets(cfg);

  it('uses the property names the real config declares', () => {
    assert.equal(cfg.CONTACT_TO, 'owner@gharse.example');

    const configSource = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'config.ts'),
      'utf8',
    );

    assert.ok(configSource.includes('CONTACT_TO: z.string().email()'));
  });

  it('masks the configured contact recipient address', () => {
    const text = 'Delivery failed to owner@gharse.example';
    const out = sanitizeDetail(text, list);
    assert.ok(!/owner@|gharse\.example/i.test(out), out);
  });

  it('masks the contact recipient in an error message', () => {
    const out = sanitizeDetail(
      'Rejected recipient owner@gharse.example',
      list,
    );
    assert.ok(!/owner@|gharse\.example/i.test(out), out);
  });

  it('still masks every database detail from the same list', () => {
    const out = sanitizeDetail(
      `${URL} ${HOST} ${USER} ${PASSWORD} ${DB}`,
      list,
    );
    assert.deepEqual(leaks(out), [], out);
  });

  it('works when email is not configured at all', () => {
    const bare = loadConfig({ DATABASE_URL: URL });
    assert.deepEqual(
      leaks(sanitizeDetail(`${HOST} ${PASSWORD}`, healthLogSecrets(bare))),
      [],
    );
  });
});


describe('health route: behaviour is unchanged', () => {
  // Static checks on the route source, so a future edit cannot quietly change the check or start logging raw errors.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'health', 'routes.ts'), 'utf8');

  it('keeps the same 5 second timeout and the same database query', () => {
    assert.ok(src.includes('withTimeout(fn(), 5000)'), 'timeout duration');
    assert.ok(src.includes('$queryRaw`SELECT 1`'), 'database check query');
  });

  it('never passes the raw error to the logger', () => {
    const rawErrorLog = 'log.error({ ' + 'err';
    assert.ok(!src.includes(rawErrorLog), 'the raw error object must not be logged');
    assert.ok(src.includes('describeHealthFailure('), 'the sanitized description is what gets logged');
  });

  it('builds the masking list from the real config', () => {
    assert.ok(src.includes('healthLogSecrets(app.config)'), 'the route masks using the configured values');
  });
});
