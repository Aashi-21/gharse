import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import type { Config } from './config';
import { createMailer } from './lib/mailer';
import { sendSpa } from './lib/staticSpa';
import { createStorage } from './lib/storage';
import { createAiClient, type AiClient } from './modules/ai/client';
import { authRoutes } from './modules/auth/routes';
import { brandRoutes } from './modules/brand/routes';
import { healthRoutes } from './modules/health/routes';
import { sellerRoutes } from './modules/seller/routes';
import { registerAuth } from './plugins/auth';
import { registerErrorHandling } from './plugins/errors';
import './types';

const publicDir = path.resolve(__dirname, '..', 'public');

export async function buildApp(config: Config, overrides: { ai?: AiClient } = {}) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  const prisma = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
  app.decorate('prisma', prisma);
  app.decorate('config', config);
  app.decorate('storage', createStorage(config));
  app.decorate('mailer', createMailer(config));
  app.decorate('ai', overrides.ai ?? createAiClient(config, prisma, app.log));
  app.addHook('onClose', async () => {
    await prisma.$disconnect();
  });

  registerErrorHandling(app);

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Only force https upgrades when the app is actually served over https.
        upgradeInsecureRequests: config.cookieSecure ? [] : null,
      },
    },
    strictTransportSecurity: config.cookieSecure,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  // CSRF defence in depth (on top of SameSite=Lax cookies and JSON-only bodies):
  // state-changing requests must come from our own origin.
  const appOrigin = new URL(config.APP_URL).origin;
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try {
        host = new URL(origin).host;
      } catch {
        /* malformed origin -> rejected below */
      }
      if (origin !== appOrigin && host !== req.headers.host) {
        return reply.code(403).send({ error: { code: 'bad_origin', message: 'Request blocked.' } });
      }
    } else if (req.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: { code: 'bad_origin', message: 'Request blocked.' } });
    }
  });

  registerAuth(app);
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(sellerRoutes);
  await app.register(brandRoutes);

  // Serve the built React app (single deployable). In dev, Vite serves the web app instead.
  const hasWeb = fs.existsSync(path.join(publicDir, 'index.html'));
  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && (req.method === 'GET' || req.method === 'HEAD') && !req.url.startsWith('/api/')) return sendSpa(publicDir, req.url, reply);
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  return app;
}
