import type { FastifyInstance } from 'fastify';
import { getSellerStore } from '../../lib/ownership';
import { enforceAiQuota } from '../ai/client';
import { generateBrand } from '../ai/brandService';
import { brandBriefSchema, brandFieldsSchema } from '../ai/schemas';

/** Brand memory lives here: one approved row per store in PostgreSQL, versioned on every approval. */
export async function brandRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.requireAuth);

  app.get('/api/seller/brand', async (req) => {
    const store = await getSellerStore(app.prisma, req.user!.id);
    return { brand: await app.prisma.brandProfile.findUnique({ where: { storeId: store.id } }) };
  });

  // Generates a SUGGESTION only. Nothing is saved until the seller reviews, edits and approves it.
  app.post('/api/seller/brand/generate', async (req) => {
    const brief = brandBriefSchema.parse(req.body);
    const store = await getSellerStore(app.prisma, req.user!.id);
    await enforceAiQuota(app.prisma, app.config, store.id);
    const suggestion = await generateBrand(app.ai, { model: app.config.CLAUDE_MODEL_SMART, storeId: store.id, brief });
    return { suggestion };
  });

  // "Approve & save": validates the (possibly edited) brand and stores it as the new approved version.
  app.put('/api/seller/brand', async (req) => {
    const b = brandFieldsSchema.parse(req.body);
    const store = await getSellerStore(app.prisma, req.user!.id);
    const data = { ...b, primaryColor: b.primaryColor.toUpperCase(), secondaryColor: b.secondaryColor.toUpperCase() };
    const brand = await app.prisma.$transaction(async (tx) => {
      const existing = await tx.brandProfile.findUnique({ where: { storeId: store.id } });
      return tx.brandProfile.upsert({
        where: { storeId: store.id },
        create: { storeId: store.id, ...data, status: 'APPROVED', version: 1, approvedAt: new Date() },
        update: { ...data, status: 'APPROVED', version: (existing?.version ?? 0) + 1, approvedAt: new Date() },
      });
    });
    return { brand };
  });
}
