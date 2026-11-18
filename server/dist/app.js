"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildApp = buildApp;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const cookie_1 = __importDefault(require("@fastify/cookie"));
const multipart_1 = __importDefault(require("@fastify/multipart"));
const helmet_1 = __importDefault(require("@fastify/helmet"));
const rate_limit_1 = __importDefault(require("@fastify/rate-limit"));
const client_1 = require("@prisma/client");
const fastify_1 = __importDefault(require("fastify"));
const imageInfo_1 = require("./lib/imageInfo");
const mailer_1 = require("./lib/mailer");
const staticSpa_1 = require("./lib/staticSpa");
const storage_1 = require("./lib/storage");
const client_2 = require("./modules/ai/client");
const routes_1 = require("./modules/auth/routes");
const routes_2 = require("./modules/brand/routes");
const routes_3 = require("./modules/contact/routes");
const publicRoutes_1 = require("./modules/orders/publicRoutes");
const sellerRoutes_1 = require("./modules/orders/sellerRoutes");
const routes_4 = require("./modules/products/routes");
const routes_5 = require("./modules/public/routes");
const settings_1 = require("./modules/storefront/settings");
const routes_6 = require("./modules/health/routes");
const routes_7 = require("./modules/seller/routes");
const auth_1 = require("./plugins/auth");
const errors_1 = require("./plugins/errors");
require("./types");
const adapter_neon_1 = require("@prisma/adapter-neon");
const serverless_1 = require("@neondatabase/serverless");
const ws_1 = __importDefault(require("ws"));
const publicDir = node_path_1.default.resolve(__dirname, '..', 'public');
function createPrismaClient(config) {
    if (config.DATABASE_TRANSPORT === 'neon-websocket') {
        serverless_1.neonConfig.webSocketConstructor = ws_1.default;
        const adapter = new adapter_neon_1.PrismaNeon({
            connectionString: config.DATABASE_URL,
        });
        return new client_1.PrismaClient({ adapter });
    }
    return new client_1.PrismaClient({
        datasourceUrl: config.DATABASE_URL,
    });
}
async function buildApp(config, overrides = {}) {
    const app = (0, fastify_1.default)({
        logger: config.NODE_ENV === 'test' ? false : { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
        trustProxy: config.TRUST_PROXY,
        bodyLimit: 1024 * 1024,
    });
    const prisma = createPrismaClient(config);
    app.decorate('prisma', prisma);
    app.decorate('config', config);
    app.decorate('storage', (0, storage_1.createStorage)(config));
    app.decorate('mailer', (0, mailer_1.createMailer)(config));
    app.decorate('ai', overrides.ai ?? (0, client_2.createAiClient)(config, prisma, app.log));
    app.addHook('onClose', async () => {
        await prisma.$disconnect();
    });
    (0, errors_1.registerErrorHandling)(app);
    await app.register(helmet_1.default, {
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
    await app.register(cookie_1.default);
    // One image per request; the size cap (IMAGE_LIMITS.maxBytes) and field limits are enforced while streaming.
    await app.register(multipart_1.default, {
        limits: {
            fileSize: imageInfo_1.IMAGE_LIMITS.maxBytes,
            files: 1,
            fields: 3,
            fieldSize: 4096,
            parts: 5,
        },
    });
    await app.register(rate_limit_1.default, { global: true, max: 300, timeWindow: '1 minute' });
    // CSRF defence in depth (on top of SameSite=Lax cookies and JSON-only bodies):
    // state-changing requests must come from our own origin.
    const appOrigin = new URL(config.APP_URL).origin;
    app.addHook('onRequest', async (req, reply) => {
        if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')
            return;
        const origin = req.headers.origin;
        if (origin) {
            let host = '';
            try {
                host = new URL(origin).host;
            }
            catch {
                /* malformed origin -> rejected below */
            }
            if (origin !== appOrigin && host !== req.headers.host) {
                return reply.code(403).send({ error: { code: 'bad_origin', message: 'Request blocked.' } });
            }
        }
        else if (req.headers['sec-fetch-site'] === 'cross-site') {
            return reply.code(403).send({ error: { code: 'bad_origin', message: 'Request blocked.' } });
        }
    });
    (0, auth_1.registerAuth)(app);
    await app.register(routes_6.healthRoutes);
    await app.register(routes_3.contactRoutes);
    await app.register(routes_1.authRoutes);
    await app.register(routes_7.sellerRoutes);
    await app.register(routes_2.brandRoutes);
    await app.register(routes_4.productRoutes);
    await app.register(settings_1.storeSettingsRoutes);
    await app.register(routes_5.publicRoutes);
    await app.register(publicRoutes_1.publicOrderRoutes);
    await app.register(sellerRoutes_1.sellerOrderRoutes);
    // Serve the built React app (single deployable). In dev, Vite serves the web app instead.
    const hasWeb = node_fs_1.default.existsSync(node_path_1.default.join(publicDir, 'index.html'));
    app.setNotFoundHandler((req, reply) => {
        if (hasWeb && (req.method === 'GET' || req.method === 'HEAD') && !req.url.startsWith('/api/')) {
            return (0, staticSpa_1.sendSpa)(publicDir, req.url, reply);
        }
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    });
    return app;
}
//# sourceMappingURL=app.js.map