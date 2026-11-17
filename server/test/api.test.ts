import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config';
import { hashPassword, verifyPassword } from '../src/lib/password';
import { cookieFrom, makeApp, register, resetDb, validProfile } from './helpers';

let app: FastifyInstance;
let prisma: PrismaClient;

before(async () => {
  ({ app } = await makeApp());
  prisma = app.prisma;
});
after(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
});

const json = (res: { body: string }) => JSON.parse(res.body);

describe('config', () => {
  it('rejects missing DATABASE_URL with a readable message', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'test' }), /DATABASE_URL/);
  });
  it('requires MAIL_FROM/CONTACT_TO when SMTP_HOST is set', () => {
    assert.throws(
      () => loadConfig({ DATABASE_URL: 'postgresql://a:b@h/db', SMTP_HOST: 'smtp.example.com' }),
      /MAIL_FROM/,
    );
  });
});

describe('password hashing', () => {
  it('hashes with salt and verifies', async () => {
    const h1 = await hashPassword('secret-pass-1');
    const h2 = await hashPassword('secret-pass-1');
    assert.notEqual(h1, h2);
    assert.ok(h1.startsWith('scrypt$'));
    assert.equal(await verifyPassword('secret-pass-1', h1), true);
    assert.equal(await verifyPassword('wrong', h1), false);
    assert.equal(await verifyPassword('x', 'garbage'), false);
  });
});

describe('health', () => {
  it('reports database + storage ok, email not_configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    const b = json(res);
    assert.equal(b.status, 'ok');
    assert.equal(b.checks.database, 'ok');
    assert.deepEqual(b.checks.storage, { status: 'ok', driver: 'local' });
    assert.equal(b.checks.email, 'not_configured');
  });

  it('returns 503 and hides details when the database is unreachable', async () => {
    const { app: bad } = await makeApp({ DATABASE_URL: 'postgresql://gharse:gharse@localhost:1/nope_test' });
    const res = await bad.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 503);
    assert.equal(json(res).checks.database, 'fail');
    assert.ok(!res.body.includes('localhost'));
    await bad.close();
  });

  it('reports email fail when SMTP is configured but unreachable', async () => {
    const { app: m } = await makeApp({
      SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', MAIL_FROM: 'a@b.test', CONTACT_TO: 'c@d.test',
    });
    const res = await m.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200); // email problems do not take the app "down"
    assert.equal(json(res).checks.email, 'fail');
    await m.close();
  });
});

describe('auth', () => {
  it('registers, sets an httpOnly session cookie, and /me works', async () => {
    const { res, cookie } = await register(app, 'Riya@Example.com');
    assert.equal(res.statusCode, 201);
    const setCookie = String(res.headers['set-cookie']);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    assert.equal(me.statusCode, 200);
    assert.equal(json(me).user.email, 'riya@example.com');
    assert.deepEqual(json(me).onboarding, { profileComplete: false, storeComplete: false });
  });

  it('never stores the plain password or raw session token', async () => {
    const { cookie } = await register(app, 'a@example.com', 'plain-text-pw-1');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'a@example.com' } });
    assert.ok(!user.passwordHash.includes('plain-text-pw-1'));
    const token = cookie.split('=')[1];
    const sessions = await prisma.session.findMany();
    assert.equal(sessions.length, 1);
    assert.notEqual(sessions[0].tokenHash, token);
  });

  it('rejects duplicate email, weak password, bad email', async () => {
    await register(app, 'dup@example.com');
    const dup = await register(app, 'DUP@example.com');
    assert.equal(dup.res.statusCode, 409);
    const weak = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'w@example.com', password: 'short' } });
    assert.equal(weak.statusCode, 400);
    assert.ok(json(weak).error.fields.password);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'nope', password: 'long-enough-pw' } });
    assert.equal(bad.statusCode, 400);
  });

  it('login succeeds with the right password and fails identically for wrong password / unknown email', async () => {
    await register(app, 'l@example.com', 'right-password-1');
    const ok = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'l@example.com', password: 'right-password-1' } });
    assert.equal(ok.statusCode, 200);
    assert.ok(ok.headers['set-cookie']);
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'l@example.com', password: 'nope-nope-nope' } });
    const unknown = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@example.com', password: 'nope-nope-nope' } });
    assert.equal(wrong.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(json(wrong), json(unknown));
  });

  it('a new login after logout works as a separate session (persistence across sessions)', async () => {
    const { cookie: c1 } = await register(app, 's@example.com', 'right-password-1');
    await app.inject({ method: 'PUT', url: '/api/seller/profile', headers: { cookie: c1 }, payload: validProfile });
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: c1 } });
    assert.equal(out.statusCode, 204);
    const afterLogout = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: c1 } });
    assert.equal(afterLogout.statusCode, 401); // old session is dead server-side
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 's@example.com', password: 'right-password-1' } });
    const c2 = cookieFrom(login);
    assert.notEqual(c1, c2);
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: c2 } });
    assert.equal(json(me).profile.fullName, 'Riya Sharma'); // data survived from the earlier session
  });

  it('expired sessions are rejected and removed', async () => {
    const { cookie } = await register(app, 'e@example.com');
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    assert.equal(me.statusCode, 401);
    assert.equal(await prisma.session.count(), 0);
  });

  it('rate limits login attempts', async () => {
    const { app: limited } = await makeApp({ AUTH_RATE_LIMIT_MAX: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await limited.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'z@example.com', password: 'whatever-pw' } });
      codes.push(r.statusCode);
    }
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
    await limited.close();
  });

  it('blocks cross-origin state-changing requests', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { email: 'a@example.com', password: 'whatever-pw' },
    });
    assert.equal(res.statusCode, 403);
  });
});

describe('seller profile + store', () => {
  it('requires authentication', async () => {
    for (const [method, url] of [['GET', '/api/seller/profile'], ['PUT', '/api/seller/profile'], ['GET', '/api/seller/store'], ['PUT', '/api/seller/store']] as const) {
      const res = await app.inject({ method, url, payload: method === 'PUT' ? {} : undefined });
      assert.equal(res.statusCode, 401, `${method} ${url}`);
    }
  });

  it('creates and updates a profile, normalising the phone number', async () => {
    const { cookie } = await register(app, 'p@example.com');
    const created = await app.inject({ method: 'PUT', url: '/api/seller/profile', headers: { cookie }, payload: validProfile });
    assert.equal(created.statusCode, 200);
    assert.equal(json(created).profile.phone, '9876543210');
    assert.equal(json(created).profile.whatsapp, null);
    const updated = await app.inject({ method: 'PUT', url: '/api/seller/profile', headers: { cookie }, payload: { ...validProfile, city: 'Mumbai' } });
    assert.equal(json(updated).profile.city, 'Mumbai');
    assert.equal(await prisma.sellerProfile.count(), 1);
  });

  it('validates profile fields', async () => {
    const { cookie } = await register(app, 'v@example.com');
    const res = await app.inject({ method: 'PUT', url: '/api/seller/profile', headers: { cookie }, payload: { ...validProfile, phone: '12345', fullName: '' } });
    assert.equal(res.statusCode, 400);
    const f = json(res).error.fields;
    assert.ok(f.phone && f.fullName);
  });

  it('keeps each seller’s data isolated', async () => {
    const a = await register(app, 'a@example.com');
    const b = await register(app, 'b@example.com');
    await app.inject({ method: 'PUT', url: '/api/seller/profile', headers: { cookie: a.cookie }, payload: { ...validProfile, fullName: 'Seller A' } });
    const bProfile = await app.inject({ method: 'GET', url: '/api/seller/profile', headers: { cookie: b.cookie } });
    assert.equal(json(bProfile).profile, null);
    await app.inject({ method: 'PUT', url: '/api/seller/profile', headers: { cookie: b.cookie }, payload: { ...validProfile, fullName: 'Seller B' } });
    const aProfile = await app.inject({ method: 'GET', url: '/api/seller/profile', headers: { cookie: a.cookie } });
    assert.equal(json(aProfile).profile.fullName, 'Seller A');
  });

  it('store needs a profile first, enforces unique/valid/reserved slugs', async () => {
    const a = await register(app, 'a@example.com');
    const b = await register(app, 'b@example.com');
    const noProfile = await app.inject({ method: 'PUT', url: '/api/seller/store', headers: { cookie: a.cookie }, payload: { slug: 'riyas-creations' } });
    assert.equal(noProfile.statusCode, 409);
    await app.inject({ method: 'PUT', url: '/api/seller/profile', headers: { cookie: a.cookie }, payload: validProfile });
    await app.inject({ method: 'PUT', url: '/api/seller/profile', headers: { cookie: b.cookie }, payload: validProfile });

    const ok = await app.inject({ method: 'PUT', url: '/api/seller/store', headers: { cookie: a.cookie }, payload: { slug: 'Riyas-Creations' } });
    assert.equal(ok.statusCode, 200);
    assert.equal(json(ok).store.slug, 'riyas-creations');

    const taken = await app.inject({ method: 'PUT', url: '/api/seller/store', headers: { cookie: b.cookie }, payload: { slug: 'riyas-creations' } });
    assert.equal(taken.statusCode, 409);
    assert.equal(json(taken).error.code, 'slug_taken');

    for (const slug of ['ab', 'has space', 'UPPER_case', 'api', '-bad-', 'a--b']) {
      const r = await app.inject({ method: 'PUT', url: '/api/seller/store', headers: { cookie: b.cookie }, payload: { slug } });
      assert.equal(r.statusCode, 400, slug);
    }

    const check = await app.inject({ method: 'GET', url: '/api/seller/store/slug-check?slug=riyas-creations', headers: { cookie: b.cookie } });
    assert.equal(json(check).available, false);
    const mine = await app.inject({ method: 'GET', url: '/api/seller/store/slug-check?slug=riyas-creations', headers: { cookie: a.cookie } });
    assert.equal(json(mine).available, true);
    const free = await app.inject({ method: 'GET', url: '/api/seller/store/slug-check?slug=free-name', headers: { cookie: b.cookie } });
    assert.equal(json(free).available, true);
  });

  it('allows slug changes while unpublished but not after publishing', async () => {
    const { cookie } = await register(app, 'a@example.com');
    await app.inject({ method: 'PUT', url: '/api/seller/profile', headers: { cookie }, payload: validProfile });
    await app.inject({ method: 'PUT', url: '/api/seller/store', headers: { cookie }, payload: { slug: 'first-name' } });
    const change = await app.inject({ method: 'PUT', url: '/api/seller/store', headers: { cookie }, payload: { slug: 'second-name' } });
    assert.equal(change.statusCode, 200);
    await prisma.store.updateMany({ data: { isPublished: true } });
    const locked = await app.inject({ method: 'PUT', url: '/api/seller/store', headers: { cookie }, payload: { slug: 'third-name' } });
    assert.equal(locked.statusCode, 409);
    assert.equal(json(locked).error.code, 'slug_locked');
  });
});

describe('errors', () => {
  it('returns safe JSON for malformed bodies and unknown routes', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{not json' });
    assert.equal(bad.statusCode, 400);
    assert.equal(json(bad).error.code, 'bad_request');
    const nf = await app.inject({ method: 'GET', url: '/api/nope' });
    assert.equal(nf.statusCode, 404);
  });
});
