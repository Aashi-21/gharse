"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_DELIVERY_CHARGE_PAISE = exports.MIN_POLICY_LENGTH = void 0;
exports.getStorePublishIssues = getStorePublishIssues;
exports.storeSettingsRoutes = storeSettingsRoutes;
const zod_1 = require("zod");
const httpError_1 = require("../../lib/httpError");
const indiaAddress_1 = require("../../lib/indiaAddress");
const ownership_1 = require("../../lib/ownership");
const visibility_1 = require("../products/visibility");
exports.MIN_POLICY_LENGTH = 10;
exports.MAX_DELIVERY_CHARGE_PAISE = 1_000_000; // ₹10,000
/**
 * The single, backend-authoritative definition of "this store may be shown to customers".
 * Store publication is independent of product publication: a store needs at least one PUBLISHED product to go live,
 * but publishing a product never publishes the store (and vice versa).
 */
function getStorePublishIssues(s, hasApprovedBrand, publishedProducts) {
    const issues = [];
    if (!hasApprovedBrand)
        issues.push({ field: 'brand', message: 'Create and approve your brand first.' });
    if (!s.contactPhone)
        issues.push({ field: 'contactPhone', message: 'Add the phone number customers can contact you on.' });
    if (!s.deliveryPolicy || s.deliveryPolicy.trim().length < exports.MIN_POLICY_LENGTH) {
        issues.push({ field: 'deliveryPolicy', message: `Describe your delivery policy (at least ${exports.MIN_POLICY_LENGTH} characters).` });
    }
    if (!s.returnPolicy || s.returnPolicy.trim().length < exports.MIN_POLICY_LENGTH) {
        issues.push({ field: 'returnPolicy', message: `Describe your return policy (at least ${exports.MIN_POLICY_LENGTH} characters).` });
    }
    if (publishedProducts < 1)
        issues.push({ field: 'products', message: 'Publish at least one product.' });
    return issues;
}
const emptyToNull = (v) => (typeof v === 'string' && v.trim() === '' ? null : v);
/** Rupees as typed ("0", "60", "60.50", "₹ 60") -> integer paise, 0 allowed (free delivery). */
const deliveryCharge = zod_1.z
    .union([zod_1.z.string(), zod_1.z.number()])
    .transform((v, ctx) => {
    const s = String(v).trim().replace(/^₹\s*/, '');
    if (s === '')
        return 0;
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(s)) {
        ctx.addIssue({ code: 'custom', message: 'Enter the delivery charge in rupees, like 60 or 0 for free delivery' });
        return zod_1.z.NEVER;
    }
    const paise = Math.round(Number(s) * 100);
    if (paise > exports.MAX_DELIVERY_CHARGE_PAISE) {
        ctx.addIssue({ code: 'custom', message: 'The delivery charge cannot be more than ₹10,000' });
        return zod_1.z.NEVER;
    }
    return paise;
});
const policy = zod_1.z.preprocess(emptyToNull, zod_1.z.string().trim().max(1000, 'Keep it under 1000 characters').nullable());
// Every field is optional (omitted = unchanged). The contact phone is NEVER copied from the seller's profile:
// it is shown to customers only if the seller types it here.
const settingsBody = zod_1.z.object({
    contactPhone: zod_1.z.preprocess(emptyToNull, indiaAddress_1.indianPhone.nullable()).optional(),
    deliveryPolicy: policy.optional(),
    returnPolicy: policy.optional(),
    deliveryCharge: deliveryCharge.optional(),
});
/** Seller-facing store settings and the explicit "make my store public" action. All scoped to the seller's own store. */
async function storeSettingsRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    const view = async (storeId) => {
        const [store, brand, publishedProducts] = await Promise.all([
            app.prisma.store.findUniqueOrThrow({ where: { id: storeId } }),
            app.prisma.brandProfile.findFirst({ where: { storeId, status: 'APPROVED' }, select: { id: true } }),
            app.prisma.product.count({ where: { storeId, ...visibility_1.PUBLIC_PRODUCT_FILTER } }),
        ]);
        const issues = getStorePublishIssues(store, !!brand, publishedProducts);
        return {
            slug: store.slug,
            isPublished: store.isPublished,
            isSample: store.isSample,
            settings: {
                contactPhone: store.contactPhone,
                deliveryPolicy: store.deliveryPolicy,
                returnPolicy: store.returnPolicy,
                deliveryChargePaise: store.deliveryChargePaise,
            },
            readiness: { canPublish: issues.length === 0, issues },
        };
    };
    app.get('/api/seller/store/settings', async (req) => {
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        return view(store.id);
    });
    app.put('/api/seller/store/settings', async (req) => {
        const b = settingsBody.parse(req.body);
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        await app.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM stores WHERE id = ${store.id} FOR UPDATE`;
            const cur = await tx.store.findUniqueOrThrow({ where: { id: store.id } });
            const next = {
                contactPhone: b.contactPhone !== undefined ? b.contactPhone : cur.contactPhone,
                deliveryPolicy: b.deliveryPolicy !== undefined ? b.deliveryPolicy : cur.deliveryPolicy,
                returnPolicy: b.returnPolicy !== undefined ? b.returnPolicy : cur.returnPolicy,
            };
            // A LIVE store must keep the details customers rely on.
            if (cur.isPublished) {
                const issues = getStorePublishIssues(next, true, 1).filter((i) => i.field !== 'products' && i.field !== 'brand');
                if (issues.length > 0) {
                    throw new httpError_1.HttpError(400, 'validation_error', 'Your store is live, so it must keep its contact phone and policies. Unpublish it first if you want to remove them.', Object.fromEntries(issues.map((i) => [i.field, i.message])));
                }
            }
            await tx.store.update({
                where: { id: store.id },
                data: { ...next, ...(b.deliveryCharge !== undefined && { deliveryChargePaise: b.deliveryCharge }) },
            });
        });
        return view(store.id);
    });
    // Make the store public. Validated on the locked row inside one transaction; idempotent.
    app.post('/api/seller/store/publish', async (req) => {
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        await app.prisma.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM stores WHERE id = ${store.id} FOR UPDATE`;
            const cur = await tx.store.findUniqueOrThrow({ where: { id: store.id } });
            if (cur.isPublished)
                return;
            const [brand, publishedProducts] = await Promise.all([
                tx.brandProfile.findFirst({ where: { storeId: store.id, status: 'APPROVED' }, select: { id: true } }),
                tx.product.count({ where: { storeId: store.id, ...visibility_1.PUBLIC_PRODUCT_FILTER } }),
            ]);
            const issues = getStorePublishIssues(cur, !!brand, publishedProducts);
            if (issues.length > 0) {
                throw new httpError_1.HttpError(400, 'store_not_publishable', 'Your store is not ready to go public yet.', Object.fromEntries(issues.map((i) => [i.field, i.message])));
            }
            await tx.store.update({ where: { id: store.id }, data: { isPublished: true } });
        });
        return view(store.id);
    });
    // Take the store offline. Products and orders are untouched.
    app.post('/api/seller/store/unpublish', async (req) => {
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        await app.prisma.store.update({ where: { id: store.id }, data: { isPublished: false } });
        return view(store.id);
    });
}
//# sourceMappingURL=settings.js.map