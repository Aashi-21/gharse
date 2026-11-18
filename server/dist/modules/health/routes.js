"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthRoutes = healthRoutes;
const diagnose_1 = require("./diagnose");
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new diagnose_1.HealthTimeoutError()), ms))]);
/**
 * Deployment health check. Reports only ok/fail/not_configured per subsystem —
 * never error details or secrets (details go to the server log).
 */
async function healthRoutes(app) {
    // Values that must never appear in a log line: every part of the database URL and the mail settings (including SMTP_PASS).
    const secrets = (0, diagnose_1.healthLogSecrets)(app.config);
    const run = async (name, fn) => {
        const started = Date.now();
        try {
            await withTimeout(fn(), 5000);
            return 'ok';
        }
        catch (err) {
            // TEMPORARY diagnostics: log only sanitized fields (class, code, timeout flag, one masked line), never the raw error.
            const failure = (0, diagnose_1.describeHealthFailure)(name, err, secrets, Date.now() - started);
            app.log.error(failure, (0, diagnose_1.healthFailureMessage)(failure));
            return 'fail';
        }
    };
    // SMTP verification is slow and public endpoints can be hammered, so cache it for a minute.
    let emailCache = null;
    const checkEmail = async () => {
        if (!app.mailer)
            return 'not_configured';
        if (emailCache && Date.now() - emailCache.at < 60_000)
            return emailCache.result;
        const result = await run('email', () => app.mailer.verify());
        emailCache = { at: Date.now(), result };
        return result;
    };
    app.get('/api/health', async (_req, reply) => {
        const [database, storage, email] = await Promise.all([
            run('database', () => app.prisma.$queryRaw `SELECT 1`),
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
//# sourceMappingURL=routes.js.map