import type { FastifyInstance } from 'fastify';
import { HttpError } from '../../lib/httpError';
import { checkoutSchema, idempotencyKeySchema, placeOrder, toConfirmation } from './checkout';

/**
 * Public checkout: no customer account, no payment. Customer details are accepted and stored for the seller, but are
 * never returned by any public endpoint and never written to logs (see errorLogPayload in plugins/errors.ts).
 */
export async function publicOrderRoutes(app: FastifyInstance) {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  app.post<{ Params: { slug: string } }>(
    '/api/public/stores/:slug/orders',
    // Per-IP limit. It only sees the real client IP if TRUST_PROXY is configured for the actual proxy.
    { config: { rateLimit: { max: app.config.ORDER_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const key = idempotencyKeySchema.safeParse(req.headers['idempotency-key']);
      if (!key.success) {
        throw new HttpError(400, 'validation_error', 'Please try again.', { 'Idempotency-Key': key.error.issues[0].message });
      }
      const input = checkoutSchema.parse(req.body);
      const { order, replayed } = await placeOrder(app.prisma, app.config, req.params.slug, key.data, input);
      return reply.code(replayed ? 200 : 201).send({ order: toConfirmation(order), replayed });
    },
  );
}
