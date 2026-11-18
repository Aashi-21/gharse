"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.publicRoutes = publicRoutes;
const visibility_1 = require("../products/visibility");
const dto_1 = require("./dto");
const store_1 = require("./store");
/**
 * Customer-facing read API. No authentication. Every route answers with the SAME generic 404 whether the store
 * does not exist, is not published, has no approved brand, or the product is not live, so nothing can be enumerated.
 * Product queries always spread PUBLIC_PRODUCT_FILTER (only PUBLISHED products are ever visible).
 */
async function publicRoutes(app) {
    // Stock and visibility change often: never let a browser or proxy serve a stale store page.
    app.addHook('onSend', async (req, reply) => {
        if (!reply.hasHeader('cache-control'))
            reply.header('Cache-Control', 'no-store');
    });
    const loadStore = (slug) => (0, store_1.findPublicStore)(app.prisma, slug);
    async function loadProduct(storeId, productSlug) {
        if (!(0, store_1.isSlug)(productSlug, 80))
            throw (0, store_1.notFound)();
        const product = await app.prisma.product.findFirst({
            where: { storeId, slug: productSlug, ...visibility_1.PUBLIC_PRODUCT_FILTER },
            include: { images: true },
        });
        if (!product)
            throw (0, store_1.notFound)();
        return product;
    }
    app.get('/api/public/stores/:slug', async (req) => {
        const store = await loadStore(req.params.slug);
        const products = await app.prisma.product.findMany({
            where: { storeId: store.id, ...visibility_1.PUBLIC_PRODUCT_FILTER },
            include: { images: true },
            orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
        });
        return { store: (0, dto_1.toPublicStore)(store), products: products.map((p) => (0, dto_1.toPublicProduct)(store.slug, p)) };
    });
    app.get('/api/public/stores/:slug/products/:productSlug', async (req) => {
        const store = await loadStore(req.params.slug);
        const product = await loadProduct(store.id, req.params.productSlug);
        return { store: (0, dto_1.toPublicStore)(store), product: (0, dto_1.toPublicProduct)(store.slug, product) };
    });
    // Same visibility rules as the page. Any problem with the file itself is also just a 404 (no paths, no details).
    app.get('/api/public/stores/:slug/products/:productSlug/image', async (req, reply) => {
        const store = await loadStore(req.params.slug);
        const product = await loadProduct(store.id, req.params.productSlug);
        const image = [...product.images].sort((a, b) => a.position - b.position)[0];
        if (!image)
            throw (0, store_1.notFound)();
        let data;
        try {
            data = await app.storage.get(image.storageKey);
        }
        catch {
            app.log.warn({ productId: product.id }, 'public product image missing or unreadable in storage');
            throw (0, store_1.notFound)();
        }
        // Short public cache: images are immutable per product, but a product can be unpublished at any time.
        return reply.header('Content-Type', image.mimeType).header('Cache-Control', 'public, max-age=300').send(data);
    });
}
//# sourceMappingURL=routes.js.map