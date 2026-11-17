import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config';
import { HttpError } from '../lib/httpError';

export const SESSION_COOKIE = 'gharse_sid';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function createSession(prisma: PrismaClient, userId: string, ttlDays: number) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  await prisma.session.create({ data: { userId, tokenHash: hashToken(token), expiresAt } });
  // Opportunistic cleanup of this user's expired sessions.
  await prisma.session.deleteMany({ where: { userId, expiresAt: { lte: new Date() } } });
  return { token, expiresAt };
}

export async function destroySession(prisma: PrismaClient, token: string) {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export function setSessionCookie(reply: FastifyReply, config: Config, token: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config) {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure });
}

export function registerAuth(app: FastifyInstance) {
  app.decorateRequest('user', null);

  app.decorate('requireAuth', async (req: FastifyRequest) => {
    const token = req.cookies[SESSION_COOKIE];
    const unauthorized = new HttpError(401, 'unauthorized', 'Please log in to continue.');
    if (!token) throw unauthorized;

    const tokenHash = hashToken(token);
    const session = await app.prisma.session.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, email: true, isSample: true } } },
    });
    if (!session) throw unauthorized;
    if (session.expiresAt <= new Date()) {
      await app.prisma.session.deleteMany({ where: { tokenHash } });
      throw unauthorized;
    }
    req.user = session.user;
  });
}
