"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getApprovedBrand = getApprovedBrand;
const httpError_1 = require("../../lib/httpError");
/**
 * Brand memory: the seller's approved brand is always read fresh from PostgreSQL, keyed by the
 * authenticated seller's store. Nothing here (or in any AI call) depends on chat history or browser state.
 */
async function getApprovedBrand(prisma, storeId) {
    const brand = await prisma.brandProfile.findFirst({ where: { storeId, status: 'APPROVED' } });
    if (!brand) {
        throw new httpError_1.HttpError(409, 'brand_required', 'Please create and approve your brand before adding products, so your listings match your brand voice.');
    }
    return brand;
}
//# sourceMappingURL=service.js.map