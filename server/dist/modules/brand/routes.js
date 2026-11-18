"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.brandRoutes = brandRoutes;
const ownership_1 = require("../../lib/ownership");
const client_1 = require("../ai/client");
const brandService_1 = require("../ai/brandService");
const schemas_1 = require("../ai/schemas");
/** Brand memory lives here: one approved row per store in PostgreSQL, versioned on every approval. */
async function brandRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    app.get('/api/seller/brand', async (req) => {
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        return { brand: await app.prisma.brandProfile.findUnique({ where: { storeId: store.id } }) };
    });
    // Generates a SUGGESTION only. Nothing is saved until the seller reviews, edits and approves it.
    app.post('/api/seller/brand/generate', async (req) => {
        const brief = schemas_1.brandBriefSchema.parse(req.body);
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        await (0, client_1.enforceAiQuota)(app.prisma, app.config, store.id);
        const suggestion = await (0, brandService_1.generateBrand)(app.ai, { model: app.config.CLAUDE_MODEL_SMART, storeId: store.id, brief });
        return { suggestion };
    });
    // "Approve & save": validates the (possibly edited) brand and stores it as the new approved version.
    app.put('/api/seller/brand', async (req) => {
        const b = schemas_1.brandFieldsSchema.parse(req.body);
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
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
//# sourceMappingURL=routes.js.map