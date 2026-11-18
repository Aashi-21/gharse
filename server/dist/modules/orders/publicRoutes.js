"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicOrderRoutes = publicOrderRoutes;
const httpError_1 = require("../../lib/httpError");
const checkout_1 = require("./checkout");
/**
 * Public checkout: no customer account, no payment. Customer details are accepted and stored for the seller, but are
 * never returned by any public endpoint and never written to logs (see errorLogPayload in plugins/errors.ts).
 */
async function publicOrderRoutes(app) {
    app.addHook('onSend', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store');
    });
    app.post('/api/public/stores/:slug/orders', 
    // Per-IP limit. It only sees the real client IP if TRUST_PROXY is configured for the actual proxy.
    { config: { rateLimit: { max: app.config.ORDER_RATE_LIMIT_MAX, timeWindow: '1 minute' } } }, async (req, reply) => {
        const key = checkout_1.idempotencyKeySchema.safeParse(req.headers['idempotency-key']);
        if (!key.success) {
            throw new httpError_1.HttpError(400, 'validation_error', 'Please try again.', { 'Idempotency-Key': key.error.issues[0].message });
        }
        const input = checkout_1.checkoutSchema.parse(req.body);
        const { order, replayed } = await (0, checkout_1.placeOrder)(app.prisma, app.config, req.params.slug, key.data, input);
        return reply.code(replayed ? 200 : 201).send({ order: (0, checkout_1.toConfirmation)(order), replayed });
    });
}
//# sourceMappingURL=publicRoutes.js.map