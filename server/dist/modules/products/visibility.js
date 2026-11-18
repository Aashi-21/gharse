"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PUBLIC_PRODUCT_FILTER = void 0;
/**
 * The ONLY filter a customer-facing (public storefront) product query may use.
 * DRAFT and ARCHIVED products must never be exposed to customers, so public endpoints must spread this into
 * their `where` clause and never build their own status condition.
 *
 *   prisma.product.findMany({ where: { storeId, ...PUBLIC_PRODUCT_FILTER } })
 *
 * (The public storefront itself is a later milestone; this pins the rule and is covered by a test.)
 */
exports.PUBLIC_PRODUCT_FILTER = { status: 'PUBLISHED' };
//# sourceMappingURL=visibility.js.map