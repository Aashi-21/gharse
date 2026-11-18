import type { FastifyInstance } from 'fastify';
import { describeHealthFailure, HealthTimeoutError, healthFailureMessage, healthLogSecrets } from './diagnose';

type CheckResult = 'ok' | 'fail';

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new HealthTimeoutError()), ms))]);

/**
 * Deployment health check. Reports only ok/fail/not_configured per subsystem —
 * never error details or secrets (details go to the server log).
 */
export async function healthRoutes(app: FastifyInstance) {
  // Values that must never appear in a log line: every part of the database URL and the mail settings (including SMTP_PASS).
  const secrets = healthLogSecrets(app.config);

  const run = async (name: string, fn: () => Promise<unknown>): Promise<CheckResult> => {
    const started = Date.now();
    try {
      await withTimeout(fn(), 5000);
      return 'ok';
    } catch (err) {
      // TEMPORARY diagnostics: log only sanitized fields (class, code, timeout flag, one masked line), never the raw error.
      const failure = describeHealthFailure(name, err, secrets, Date.now() - started);
      app.log.error(failure, healthFailureMessage(failure));
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
