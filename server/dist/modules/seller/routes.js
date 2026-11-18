"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sellerRoutes = sellerRoutes;
const client_1 = require("@prisma/client");
const zod_1 = require("zod");
const httpError_1 = require("../../lib/httpError");
const indiaAddress_1 = require("../../lib/indiaAddress");
const slug_1 = require("../../lib/slug");
const emptyToUndefined = (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const profileBody = zod_1.z.object({
    fullName: zod_1.z.string().trim().min(2, 'Enter your name').max(80),
    phone: indiaAddress_1.indianPhone,
    whatsapp: zod_1.z.preprocess(emptyToUndefined, indiaAddress_1.indianPhone.optional()),
    city: zod_1.z.string().trim().min(2, 'Enter your city').max(60),
    state: zod_1.z.string().trim().min(2, 'Select your state').max(60),
    bio: zod_1.z.preprocess(emptyToUndefined, zod_1.z.string().trim().max(500, 'Keep it under 500 characters').optional()),
});
const storeBody = zod_1.z.object({ slug: slug_1.slugSchema });
/** All routes here require a logged-in seller and only ever touch that seller's own records. */
async function sellerRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    const getProfile = (userId) => app.prisma.sellerProfile.findUnique({ where: { userId } });
    app.get('/api/seller/profile', async (req) => ({ profile: await getProfile(req.user.id) }));
    app.put('/api/seller/profile', async (req) => {
        const b = profileBody.parse(req.body);
        const data = { ...b, whatsapp: b.whatsapp ?? null, bio: b.bio ?? null };
        const profile = await app.prisma.sellerProfile.upsert({
            where: { userId: req.user.id },
            create: { userId: req.user.id, ...data },
            update: data,
        });
        return { profile };
    });
    app.get('/api/seller/store', async (req) => {
        const profile = await getProfile(req.user.id);
        const store = profile ? await app.prisma.store.findUnique({ where: { sellerProfileId: profile.id } }) : null;
        return { store };
    });
    app.get('/api/seller/store/slug-check', async (req) => {
        const parsed = slug_1.slugSchema.safeParse(req.query.slug ?? '');
        if (!parsed.success)
            return { available: false, reason: parsed.error.issues[0].message };
        const existing = await app.prisma.store.findUnique({
            where: { slug: parsed.data },
            select: { sellerProfile: { select: { userId: true } } },
        });
        const available = !existing || existing.sellerProfile.userId === req.user.id;
        return { available, reason: available ? undefined : 'This address is already taken' };
    });
    app.put('/api/seller/store', async (req) => {
        const { slug } = storeBody.parse(req.body);
        const profile = await getProfile(req.user.id);
        if (!profile)
            throw new httpError_1.HttpError(409, 'profile_required', 'Please complete your seller profile first.');
        const current = await app.prisma.store.findUnique({ where: { sellerProfileId: profile.id } });
        if (current?.isPublished && current.slug !== slug) {
            throw new httpError_1.HttpError(409, 'slug_locked', 'Your store address cannot change after it is published, because shared links would break.');
        }
        try {
            const store = current
                ? await app.prisma.store.update({ where: { id: current.id }, data: { slug } })
                : await app.prisma.store.create({ data: { sellerProfileId: profile.id, slug } });
            return { store };
        }
        catch (e) {
            if (e instanceof client_1.Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
                throw new httpError_1.HttpError(409, 'slug_taken', 'This store address is already taken.', { slug: 'Already taken' });
            }
            throw e;
        }
    });
}
//# sourceMappingURL=routes.js.map