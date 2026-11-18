"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_COOKIE = void 0;
exports.createSession = createSession;
exports.destroySession = destroySession;
exports.setSessionCookie = setSessionCookie;
exports.clearSessionCookie = clearSessionCookie;
exports.registerAuth = registerAuth;
const node_crypto_1 = require("node:crypto");
const httpError_1 = require("../lib/httpError");
exports.SESSION_COOKIE = 'gharse_sid';
const hashToken = (token) => (0, node_crypto_1.createHash)('sha256').update(token).digest('hex');
async function createSession(prisma, userId, ttlDays) {
    const token = (0, node_crypto_1.randomBytes)(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    await prisma.session.create({ data: { userId, tokenHash: hashToken(token), expiresAt } });
    // Opportunistic cleanup of this user's expired sessions.
    await prisma.session.deleteMany({ where: { userId, expiresAt: { lte: new Date() } } });
    return { token, expiresAt };
}
async function destroySession(prisma, token) {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}
function setSessionCookie(reply, config, token, expiresAt) {
    reply.setCookie(exports.SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        path: '/',
        expires: expiresAt,
    });
}
function clearSessionCookie(reply, config) {
    reply.clearCookie(exports.SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure });
}
function registerAuth(app) {
    app.decorateRequest('user', null);
    app.decorate('requireAuth', async (req) => {
        const token = req.cookies[exports.SESSION_COOKIE];
        const unauthorized = new httpError_1.HttpError(401, 'unauthorized', 'Please log in to continue.');
        if (!token)
            throw unauthorized;
        const tokenHash = hashToken(token);
        const session = await app.prisma.session.findUnique({
            where: { tokenHash },
            include: { user: { select: { id: true, email: true, isSample: true } } },
        });
        if (!session)
            throw unauthorized;
        if (session.expiresAt <= new Date()) {
            await app.prisma.session.deleteMany({ where: { tokenHash } });
            throw unauthorized;
        }
        req.user = session.user;
    });
}
//# sourceMappingURL=auth.js.map