"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMe = buildMe;
/** The "who am I and how far through onboarding" payload used by the web app. */
async function buildMe(prisma, userId) {
    const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
            id: true,
            email: true,
            isSample: true,
            sellerProfile: {
                include: {
                    store: { include: { brandProfile: { select: { name: true, version: true, status: true } } } },
                },
            },
        },
    });
    const { store: storeWithBrand, ...profile } = user.sellerProfile ?? {};
    const { brandProfile, ...store } = storeWithBrand ?? {};
    const storeId = storeWithBrand?.id;
    const [products, published, newOrders] = storeId
        ? await Promise.all([
            prisma.product.count({ where: { storeId } }),
            prisma.product.count({ where: { storeId, status: 'PUBLISHED' } }),
            prisma.order.count({ where: { storeId, status: 'NEW' } }),
        ])
        : [0, 0, 0];
    const hasProfile = !!user.sellerProfile;
    const hasStore = !!storeWithBrand;
    return {
        user: { id: user.id, email: user.email, isSample: user.isSample },
        profile: hasProfile ? profile : null,
        store: hasStore ? store : null,
        brand: brandProfile ?? null,
        counts: { products, published },
        newOrders,
        onboarding: { profileComplete: hasProfile, storeComplete: hasStore },
    };
}
//# sourceMappingURL=me.js.map