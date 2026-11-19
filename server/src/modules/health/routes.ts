import type { FastifyInstance } from 'fastify';
import {
  describeHealthFailure,
  HealthTimeoutError,
  healthFailureMessage,
  healthLogSecrets,
} from './diagnose';

type CheckResult = 'ok' | 'fail';

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new HealthTimeoutError()), ms),
    ),
  ]);

/**
 * Deployment health check. Reports only ok/fail/not_configured per subsystem.
 * Email reports configuration only; actual delivery is checked when a message is sent.
 */
export async function healthRoutes(app: FastifyInstance) {
  const secrets = healthLogSecrets(app.config);

  const run = async (
    name: string,
    fn: () => Promise<unknown>,
  ): Promise<CheckResult> => {
    const started = Date.now();

    try {
      await withTimeout(fn(), 5000);
      return 'ok';
    } catch (err) {
      const failure = describeHealthFailure(
        name,
        err,
        secrets,
        Date.now() - started,
      );
      app.log.error(failure, healthFailureMessage(failure));
      return 'fail';
    }
  };

  app.get('/api/health', async (_req, reply) => {
    const [database, storage] = await Promise.all([
      run('database', () => app.prisma.$queryRaw`SELECT 1`),
      run('storage', () => app.storage.check()),
    ]);

    const healthy = database === 'ok' && storage === 'ok';

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      checks: {
        database,
        storage: { status: storage, driver: app.storage.driver },
        email: app.mailer ? 'configured' : 'not_configured',
        ai: app.ai.configured ? 'configured' : 'not_configured',
      },
    });
  });
}