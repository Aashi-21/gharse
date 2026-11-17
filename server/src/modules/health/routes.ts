import type { FastifyInstance } from 'fastify';

type CheckResult = 'ok' | 'fail';

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

/**
 * Deployment health check. Reports only ok/fail/not_configured per subsystem —
 * never error details or secrets (details go to the server log).
 */
export async function healthRoutes(app: FastifyInstance) {
  const run = async (name: string, fn: () => Promise<unknown>): Promise<CheckResult> => {
    try {
      await withTimeout(fn(), 5000);
      return 'ok';
    } catch (err) {
      app.log.error({ err, check: name }, 'health check failed');
      return 'fail';
    }
  };

  // SMTP verification is slow and public endpoints can be hammered, so cache it for a minute.
  let emailCache: { at: number; result: CheckResult } | null = null;
  const checkEmail = async (): Promise<CheckResult | 'not_configured'> => {
    if (!app.mailer) return 'not_configured';
    if (emailCache && Date.now() - emailCache.at < 60_000) return emailCache.result;
    const result = await run('email', () => app.mailer!.verify());
    emailCache = { at: Date.now(), result };
    return result;
  };

  app.get('/api/health', async (_req, reply) => {
    const [database, storage, email] = await Promise.all([
      run('database', () => app.prisma.$queryRaw`SELECT 1`),
      run('storage', () => app.storage.check()),
      checkEmail(),
    ]);
    // Email failing/missing does not take the app down, but is visible in the response.
    const healthy = database === 'ok' && storage === 'ok';
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      checks: {
        database,
        storage: { status: storage, driver: app.storage.driver },
        email,
        ai: app.ai.configured ? 'configured' : 'not_configured',
      },
    });
  });
}
