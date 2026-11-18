"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSellerStore = getSellerStore;
const httpError_1 = require("./httpError");
/**
 * The single place that answers "which store belongs to this logged-in user".
 * Every seller-scoped query must start from the store returned here, never from a client-supplied id alone.
 */
async function getSellerStore(prisma, userId) {
    const store = await prisma.store.findFirst({ where: { sellerProfile: { userId } } });
    if (!store)
        throw new httpError_1.HttpError(409, 'store_required', 'Please finish setting up your seller profile and store address first.');
    return store;
}
//# sourceMappingURL=ownership.js.map