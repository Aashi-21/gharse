
import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { PrismaClient } from '@prisma/client';
import Fastify from 'fastify';
import type { Config } from './config';
import { IMAGE_LIMITS } from './lib/imageInfo';
import { createMailer } from './lib/mailer';
import { sendSpa } from './lib/staticSpa';
import { createStorage } from './lib/storage';
import { createAiClient, type AiClient } from './modules/ai/client';
import { authRoutes } from './modules/auth/routes';
import { brandRoutes } from './modules/brand/routes';
import { contactRoutes } from './modules/contact/routes';
import { publicOrderRoutes } from './modules/orders/publicRoutes';
import { sellerOrderRoutes } from './modules/orders/sellerRoutes';
import { productRoutes } from './modules/products/routes';
import { publicRoutes } from './modules/public/routes';
import { storeSettingsRoutes } from './modules/storefront/settings';
import { healthRoutes } from './modules/health/routes';
import { sellerRoutes } from './modules/seller/routes';
import { registerAuth } from './plugins/auth';
import { registerErrorHandling } from './plugins/errors';
import './types';
import { PrismaNeon } from '@prisma/adapter-neon';
import { neonConfig } from '@neondatabase/serverless';
import ws from 'ws';

const publicDir = path.resolve(__dirname, '..', 'public');

function createPrismaClient(config: Config): PrismaClient {
  if (config.DATABASE_TRANSPORT === 'neon-websocket') {
    neonConfig.webSocketConstructor = ws;

    const adapter = new PrismaNeon({
      connectionString: config.DATABASE_URL,
    });

    return new PrismaClient({ adapter });
  }

  return new PrismaClient({
    datasourceUrl: config.DATABASE_URL,
  });
}

export async function buildApp(config: Config, overrides: { ai?: AiClient } = {}) {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  });

  const prisma = createPrismaClient(config);

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

  // One image per request; the size cap (IMAGE_LIMITS.maxBytes) and field limits are enforced while streaming.
  await app.register(multipart, {
    limits: {
      fileSize: IMAGE_LIMITS.maxBytes,
      files: 1,
      fields: 3,
      fieldSize: 4096,
      parts: 5,
    },
  });

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
  await app.register(contactRoutes);
  await app.register(authRoutes);
  await app.register(sellerRoutes);
  await app.register(brandRoutes);
  await app.register(productRoutes);
  await app.register(storeSettingsRoutes);
  await app.register(publicRoutes);
  await app.register(publicOrderRoutes);
  await app.register(sellerOrderRoutes);

  // Serve the built React app (single deployable). In dev, Vite serves the web app instead.
  const hasWeb = fs.existsSync(path.join(publicDir, 'index.html'));

  app.setNotFoundHandler((req, reply) => {
    if (hasWeb && (req.method === 'GET' || req.method === 'HEAD') && !req.url.startsWith('/api/')) {
      return sendSpa(publicDir, req.url, reply);
    }

    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  return app;
}
