"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_ORDER_QUANTITY = void 0;
exports.toPublicStore = toPublicStore;
exports.toPublicProduct = toPublicProduct;
/** Max units a customer can add per order (also capped by stock). */
exports.MAX_ORDER_QUANTITY = 10;
/**
 * Everything a customer may see about a store. Built from an explicit whitelist: no ids, no seller profile,
 * no email, no internal flags. The contact phone is whatever the seller typed in store settings (never the profile phone).
 */
function toPublicStore(s) {
    return {
        slug: s.slug,
        name: s.brandProfile.name,
        tagline: s.brandProfile.tagline,
        story: s.brandProfile.story,
        primaryColor: s.brandProfile.primaryColor,
        secondaryColor: s.brandProfile.secondaryColor,
        contactPhone: s.contactPhone,
        deliveryPolicy: s.deliveryPolicy,
        returnPolicy: s.returnPolicy,
        deliveryChargePaise: s.deliveryChargePaise,
        isSample: s.isSample,
        /** Demo stores show products but cannot take orders. */
        checkoutEnabled: !s.isSample,
    };
}
/** Whitelisted product view. The exact stock is never exposed, only whether it is available and a capped quantity. */
function toPublicProduct(storeSlug, p) {
    return {
        slug: p.slug,
        title: p.title,
        description: p.description,
        category: p.category,
        tags: p.tags,
        pricePaise: p.pricePaise,
        inStock: p.stock > 0,
        maxQuantity: Math.min(p.stock, exports.MAX_ORDER_QUANTITY),
        imageUrl: p.images.length > 0 ? `/api/public/stores/${storeSlug}/products/${p.slug}/image` : null,
    };
}
//# sourceMappingURL=dto.js.map