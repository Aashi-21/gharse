import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/httpError';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../../lib/password';
import { clearSessionCookie, createSession, destroySession, SESSION_COOKIE, setSessionCookie } from '../../plugins/auth';
import { buildMe } from './me';

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

const registerBody = z.object({
  email,
  password: z.string().min(8, 'Use at least 8 characters').max(128, 'Use at most 128 characters'),
});
const loginBody = z.object({ email, password: z.string().min(1, 'Enter your password').max(128) });

export async function authRoutes(app: FastifyInstance) {
  const limit = { config: { rateLimit: { max: app.config.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' } } };

  app.post('/api/auth/register', limit, async (req, reply) => {
    const body = registerBody.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    let user;
    try {
      user = await app.prisma.user.create({ data: { email: body.email, passwordHash } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new HttpError(409, 'email_taken', 'An account with this email already exists. Try logging in.', {
          email: 'Already registered',
        });
      }
      throw e;
    }
    const { token, expiresAt } = await createSession(app.prisma, user.id, app.config.SESSION_TTL_DAYS);
    setSessionCookie(reply, app.config, token, expiresAt);
    return reply.code(201).send(await buildMe(app.prisma, user.id));
  });

  app.post('/api/auth/login', limit, async (req, reply) => {
    const body = loginBody.parse(req.body);
    const user = await app.prisma.user.findUnique({ where: { email: body.email } });
    // Always run a hash comparison so response time doesn't reveal whether the email exists.
    const ok = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password.');
    const { token, expiresAt } = await createSession(app.prisma, user.id, app.config.SESSION_TTL_DAYS);
    setSessionCookie(reply, app.config, token, expiresAt);
    return buildMe(app.prisma, user.id);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await destroySession(app.prisma, token);
    clearSessionCookie(reply, app.config);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', { preHandler: app.requireAuth }, async (req) => buildMe(app.prisma, req.user!.id));
}
