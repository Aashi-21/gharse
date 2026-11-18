"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRoutes = authRoutes;
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const httpError_1 = require("../../lib/httpError");
const password_1 = require("../../lib/password");
const auth_1 = require("../../plugins/auth");
const me_1 = require("./me");
const email = zod_1.z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
const registerBody = zod_1.z.object({
    email,
    password: zod_1.z.string().min(8, 'Use at least 8 characters').max(128, 'Use at most 128 characters'),
});
const loginBody = zod_1.z.object({ email, password: zod_1.z.string().min(1, 'Enter your password').max(128) });
async function authRoutes(app) {
    const limit = { config: { rateLimit: { max: app.config.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' } } };
    app.post('/api/auth/register', limit, async (req, reply) => {
        const body = registerBody.parse(req.body);
        const passwordHash = await (0, password_1.hashPassword)(body.password);
        let user;
        try {
            user = await app.prisma.user.create({ data: { email: body.email, passwordHash } });
        }
        catch (e) {
            if (e instanceof client_1.Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
                throw new httpError_1.HttpError(409, 'email_taken', 'An account with this email already exists. Try logging in.', {
                    email: 'Already registered',
                });
            }
            throw e;
        }
        const { token, expiresAt } = await (0, auth_1.createSession)(app.prisma, user.id, app.config.SESSION_TTL_DAYS);
        (0, auth_1.setSessionCookie)(reply, app.config, token, expiresAt);
        return reply.code(201).send(await (0, me_1.buildMe)(app.prisma, user.id));
    });
    app.post('/api/auth/login', limit, async (req, reply) => {
        const body = loginBody.parse(req.body);
        const user = await app.prisma.user.findUnique({ where: { email: body.email } });
        // Always run a hash comparison so response time doesn't reveal whether the email exists.
        const ok = await (0, password_1.verifyPassword)(body.password, user?.passwordHash ?? password_1.DUMMY_HASH);
        if (!user || !ok)
            throw new httpError_1.HttpError(401, 'invalid_credentials', 'Incorrect email or password.');
        const { token, expiresAt } = await (0, auth_1.createSession)(app.prisma, user.id, app.config.SESSION_TTL_DAYS);
        (0, auth_1.setSessionCookie)(reply, app.config, token, expiresAt);
        return (0, me_1.buildMe)(app.prisma, user.id);
    });
    app.post('/api/auth/logout', async (req, reply) => {
        const token = req.cookies[auth_1.SESSION_COOKIE];
        if (token)
            await (0, auth_1.destroySession)(app.prisma, token);
        (0, auth_1.clearSessionCookie)(reply, app.config);
        return reply.code(204).send();
    });
    app.get('/api/auth/me', { preHandler: app.requireAuth }, async (req) => (0, me_1.buildMe)(app.prisma, req.user.id));
}
//# sourceMappingURL=routes.js.map