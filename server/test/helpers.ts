import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import type { AiClient, StructuredRequest } from '../src/modules/ai/client';

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('TEST_DATABASE_URL is not set (see .env.example)');
// Safety: tests TRUNCATE every table, so refuse to run against anything that is not clearly a test DB.
if (!/\/[^/?]*_test(\?|$)/.test(testUrl)) throw new Error('TEST_DATABASE_URL database name must end with _test');

export async function makeApp(overrides: Record<string, string> = {}, ai?: AiClient) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gharse-uploads-'));
  const config: Config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: testUrl!,
    UPLOAD_DIR: uploadDir,
    SMTP_HOST: '',
    AUTH_RATE_LIMIT_MAX: '1000',
    ...overrides,
  });
  const app = await buildApp(config, ai ? { ai } : {});
  await app.ready();
  return { app, config, uploadDir };
}

export async function resetDb() {
  const prisma = new PrismaClient({ datasourceUrl: testUrl });
  await prisma.$executeRawUnsafe(
    'TRUNCATE users, sessions, seller_profiles, stores, brand_profiles, products, product_images, orders, order_items, ai_generations RESTART IDENTITY CASCADE',
  );
  await prisma.$disconnect();
}

export function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : (raw as string);
  return first.split(';')[0];
}

export async function register(app: FastifyInstance, email: string, password = 'correct-horse-9') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password } });
  return { res, cookie: res.statusCode === 201 ? cookieFrom(res) : '' };
}

export const validProfile = {
  fullName: 'Riya Sharma',
  phone: '+91 98765-43210',
  whatsapp: '',
  city: 'Pune',
  state: 'Maharashtra',
  bio: 'I make resin art.',
};

/** A seller who finished onboarding (profile + store). Returns the session cookie. */
export async function sellerWithStore(app: FastifyInstance, email: string, slug: string) {
  const { cookie } = await register(app, email);
  await app.inject({ method: 'PUT', url: '/api/seller/profile', headers: { cookie }, payload: validProfile });
  await app.inject({ method: 'PUT', url: '/api/seller/store', headers: { cookie }, payload: { slug } });
  return cookie;
}

/** Fake Claude: records every request and validates canned output against the real schema. */
export function fakeAi(handler: (req: StructuredRequest<any>) => unknown) {
  const calls: StructuredRequest<any>[] = [];
  const ai: AiClient & { calls: StructuredRequest<any>[] } = {
    configured: true,
    calls,
    async structured(req) {
      calls.push(req);
      return req.schema.parse(handler(req));
    },
  };
  return ai;
}

export const cannedBrand = {
  name: 'Ember & Wick',
  tagline: 'Slow light for busy evenings',
  story: 'I make small-batch candles by hand for people who want their evenings to feel a little slower and a little warmer. Every candle is poured, finished and packed by me.',
  primaryColor: '#8a4b2d',
  secondaryColor: '#e9c46a',
  tone: 'Warm, calm and personal',
  personalityTraits: ['warm', 'calm', 'handmade'],
  descriptionStyle: 'Short, friendly sentences that speak directly to the customer. Lead with how it feels, then what it is.',
  visualGuidelines: 'Soft evening light, earthy backgrounds, one product per frame, no clutter.',
  nameOptions: ['Ember & Wick', 'Slow Glow', 'Hearth Notes'],
};

/** Hand-rolled multipart body so tests exercise the real upload parser. */
export function multipartBody(parts: { name: string; filename?: string; type?: string; data: Buffer | string }[]) {
  const boundary = '----gharseTestBoundary' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disp = `form-data; name="${p.name}"` + (p.filename !== undefined ? `; filename="${p.filename}"` : '');
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disp}\r\n` + (p.type ? `Content-Type: ${p.type}\r\n` : '') + '\r\n'));
    chunks.push(Buffer.isBuffer(p.data) ? p.data : Buffer.from(p.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

/** POST /api/seller/products/analyze with one image (and optional notes). */
export function analyzeRequest(app: FastifyInstance, cookie: string, image: Buffer, opts: { notes?: string; filename?: string; type?: string; extra?: { name: string; filename?: string; data: Buffer | string }[] } = {}) {
  const parts: Parameters<typeof multipartBody>[0] = [{ name: 'image', filename: opts.filename ?? 'photo.jpg', type: opts.type ?? 'image/jpeg', data: image }];
  if (opts.notes !== undefined) parts.push({ name: 'notes', data: opts.notes });
  if (opts.extra) parts.push(...opts.extra);
  const { payload, headers } = multipartBody(parts);
  return app.inject({ method: 'POST', url: '/api/seller/products/analyze', headers: { ...headers, cookie }, payload });
}

export async function approveBrand(app: FastifyInstance, cookie: string, over: Record<string, unknown> = {}) {
  const { nameOptions: _n, ...brand } = cannedBrand;
  const res = await app.inject({ method: 'PUT', url: '/api/seller/brand', headers: { cookie }, payload: { ...brand, ...over } });
  if (res.statusCode !== 200) throw new Error('approveBrand failed: ' + res.body);
  return JSON.parse(res.body).brand;
}

export const candleListing = {
  visibleCharacteristics: ['A white pillar-style candle inside a clear glass jar', 'A plain cream label on the front of the jar'],
  title: 'White Candle in Glass Jar',
  description: 'A calm, soft-looking candle in a clear glass jar with a plain cream label. A quiet little glow for a bedside table or a bookshelf.',
  category: 'Candles & Home Fragrance',
  tags: ['candle', 'glass jar', 'white candle', 'home decor'],
  openQuestions: [
    { attribute: 'material', question: 'What is the candle made of?' },
    { attribute: 'scent', question: 'Is it scented? If yes, which fragrance?' },
    { attribute: 'size', question: 'What is the size or weight of the candle?' },
  ],
};

export const crochetListing = {
  visibleCharacteristics: ['A cream-coloured basket with chunky looped stitches', 'Two short rope-style handles'],
  title: 'Cream Crochet Basket with Handles',
  description: 'A soft, cream-coloured basket with chunky looped stitches and two short handles. A calm little piece to keep on a shelf or by the bed.',
  category: 'Crochet & Knitting',
  tags: ['crochet', 'basket', 'cream', 'storage'],
  openQuestions: [
    { attribute: 'material', question: 'What yarn or material is it made from?' },
    { attribute: 'size', question: 'What are its measurements?' },
  ],
};
