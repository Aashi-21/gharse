"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productRoutes = productRoutes;
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const httpError_1 = require("../../lib/httpError");
const ownership_1 = require("../../lib/ownership");
const slug_1 = require("../../lib/slug");
const client_1 = require("../ai/client");
const listingService_1 = require("../ai/listingService");
const service_1 = require("../brand/service");
const categories_1 = require("./categories");
const dto_1 = require("./dto");
const publishing_1 = require("./publishing");
const sellerFacts_1 = require("./sellerFacts");
const upload_1 = require("./upload");
const MAX_PRICE_PAISE = 10_000_000 * 100; // ₹1 crore
/** Rupees as typed by the seller ("499", "499.5", 499) -> integer paise. Empty -> null. */
const rupeesToPaise = zod_1.z
    .union([zod_1.z.string(), zod_1.z.number(), zod_1.z.null()])
    .transform((v, ctx) => {
    if (v === null || (typeof v === 'string' && v.trim() === ''))
        return null;
    const s = String(v).trim().replace(/^₹\s*/, '');
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(s)) {
        ctx.addIssue({ code: 'custom', message: 'Enter a price in rupees, like 499 or 499.50' });
        return zod_1.z.NEVER;
    }
    const paise = Math.round(Number(s) * 100);
    if (paise <= 0 || paise > MAX_PRICE_PAISE) {
        ctx.addIssue({ code: 'custom', message: 'Enter a price greater than ₹0' });
        return zod_1.z.NEVER;
    }
    return paise;
});
const tagsSchema = zod_1.z
    .array(zod_1.z.string().trim().toLowerCase().min(1).max(30, 'Tags must be under 30 characters'))
    .max(10, 'Use at most 10 tags')
    .transform((t) => [...new Set(t)]);
// Only these fields are editable by the seller. status/brandVersion/aiDraft can never be set from the client.
const patchBody = zod_1.z.object({
    title: zod_1.z.string().trim().min(2, 'Enter a title').max(120, 'Keep the title under 120 characters').optional(),
    description: zod_1.z.string().trim().max(3000, 'Keep the description under 3000 characters').optional(),
    category: zod_1.z.enum(categories_1.PRODUCT_CATEGORIES, { error: 'Choose a category from the list' }).nullable().optional(),
    tags: tagsSchema.optional(),
    price: rupeesToPaise.optional(),
    stock: zod_1.z.number({ error: 'Enter a whole number' }).int('Enter a whole number').min(0, 'Stock cannot be negative').max(100000).optional(),
});
// Publishing is an explicit seller action: the API itself refuses to publish without the accuracy confirmation.
const publishBody = zod_1.z.object({
    confirmAccuracy: zod_1.z.literal(true, { error: 'Please confirm that you have checked the listing is accurate.' }),
});
const regenerateBody = zod_1.z.object({
    answers: zod_1.z
        .array(zod_1.z.object({
        attribute: zod_1.z.string().trim().min(1).max(40),
        answer: zod_1.z.string().trim().max(300, 'Keep each answer under 300 characters'),
    }))
        .max(10, 'Too many answers')
        .default([]),
    notes: zod_1.z.string().trim().max(600, 'Keep the notes under 600 characters').optional(),
});
/** Every query below starts from the logged-in seller's store, so a product id from another seller is simply "not found". */
async function productRoutes(app) {
    app.addHook('preHandler', app.requireAuth);
    async function ownedProduct(userId, id) {
        const store = await (0, ownership_1.getSellerStore)(app.prisma, userId);
        const product = await app.prisma.product.findFirst({ where: { id, storeId: store.id }, include: { images: true } });
        if (!product)
            throw new httpError_1.HttpError(404, 'not_found', 'Product not found.');
        return product;
    }
    app.get('/api/seller/products', async (req) => {
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        const products = await app.prisma.product.findMany({
            where: { storeId: store.id },
            include: { images: true },
            orderBy: { createdAt: 'desc' },
        });
        return { products: products.map(dto_1.toProductDto) };
    });
    // Photo -> brand-consistent DRAFT listing. Nothing is published; price and stock are left for the seller.
    app.post('/api/seller/products/analyze', async (req, reply) => {
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        // Brand memory: read the approved brand from PostgreSQL on every request. 409 if there isn't one.
        const brand = await (0, service_1.getApprovedBrand)(app.prisma, store.id);
        const { image, info, notes } = await (0, upload_1.readProductUpload)(req); // validates bytes before any AI spend
        await (0, client_1.enforceAiQuota)(app.prisma, app.config, store.id);
        const startedAt = new Date();
        const listing = await (0, listingService_1.generateListing)(app.ai, {
            model: app.config.CLAUDE_MODEL_SMART,
            storeId: store.id,
            brand,
            image: { base64: image.toString('base64'), mime: info.mime },
            notes,
        });
        // Only now touch storage and the DB, so a failed Claude call leaves nothing behind.
        const storageKey = `products/${store.id}/${(0, node_crypto_1.randomUUID)()}.${info.ext}`;
        await app.storage.put(storageKey, image);
        let product;
        try {
            product = await app.prisma.product.create({
                data: {
                    storeId: store.id,
                    slug: `${(0, slug_1.slugify)(listing.title)}-${(0, node_crypto_1.randomBytes)(3).toString('hex')}`,
                    title: listing.title,
                    description: listing.description,
                    category: listing.category,
                    tags: [...new Set(listing.tags.map((t) => t.toLowerCase()))].slice(0, 10),
                    visibleCharacteristics: listing.visibleCharacteristics,
                    openQuestions: listing.openQuestions,
                    aiDraft: listing,
                    brandVersion: brand.version,
                    sellerNotes: notes ? { text: notes } : undefined,
                    status: 'DRAFT',
                    images: { create: { storageKey, mimeType: info.mime, sizeBytes: image.length } },
                },
                include: { images: true },
            });
        }
        catch (err) {
            await app.storage.delete(storageKey);
            throw err;
        }
        // Link this request's audit rows (all attempts) to the new product.
        await app.prisma.aiGeneration.updateMany({
            where: { storeId: store.id, kind: 'LISTING', productId: null, createdAt: { gte: startedAt } },
            data: { productId: product.id },
        });
        return reply.code(201).send({ product: (0, dto_1.toProductDto)(product) });
    });
    app.get('/api/seller/products/:id', async (req) => {
        const product = await ownedProduct(req.user.id, req.params.id);
        return { product: (0, dto_1.toProductDto)(product) };
    });
    app.patch('/api/seller/products/:id', async (req) => {
        const b = patchBody.parse(req.body);
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        const product = await app.prisma.$transaction(async (tx) => {
            const row = await (0, publishing_1.lockOwnedProduct)(tx, store.id, req.params.id);
            const next = {
                title: b.title ?? row.title,
                description: b.description ?? row.description,
                category: b.category !== undefined ? b.category : row.category,
                pricePaise: b.price !== undefined ? b.price : row.pricePaise,
                stock: b.stock ?? row.stock,
            };
            // A LIVE product must stay publishable after every edit (stock may drop to 0 = sold out).
            // Drafts stay lenient so sellers can save work in progress.
            if (row.status === 'PUBLISHED') {
                const issues = (0, publishing_1.getPublishIssues)(next, row.images.length, { live: true });
                if (issues.length > 0) {
                    throw new httpError_1.HttpError(400, 'validation_error', 'This product is live, so it must keep its title, description, category and price. Unpublish it first if you want to remove them.', (0, publishing_1.issuesToFields)(issues));
                }
            }
            return tx.product.update({
                where: { id: row.id },
                data: {
                    ...(b.title !== undefined && { title: b.title }),
                    ...(b.description !== undefined && { description: b.description }),
                    ...(b.category !== undefined && { category: b.category }),
                    ...(b.tags !== undefined && { tags: b.tags }),
                    ...(b.price !== undefined && { pricePaise: b.price }),
                    ...(b.stock !== undefined && { stock: b.stock }),
                },
                include: { images: true },
            });
        });
        return { product: (0, dto_1.toProductDto)(product) };
    });
    // Draft -> PUBLISHED. Validates the LOCKED row inside one transaction; never fills in missing values.
    // Deliberately does not touch Store.isPublished (the public storefront milestone owns store visibility).
    app.post('/api/seller/products/:id/publish', async (req) => {
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        publishBody.parse(req.body ?? {});
        // Photo files are verified BEFORE the transaction, so no database lock is ever held across storage I/O.
        // Scoped by store: another seller's product is "not found" exactly as before. Only DRAFTs are checked
        // (already-live and archived products cost no I/O); metadata only, one stat per photo.
        const pre = await app.prisma.product.findFirst({
            where: { id: req.params.id, storeId: store.id },
            select: { status: true, images: { select: { id: true, storageKey: true, sizeBytes: true } } },
        });
        if (!pre)
            throw new httpError_1.HttpError(404, 'not_found', 'Product not found.');
        const usableImages = new Set();
        if (pre.status === 'DRAFT') {
            for (const image of pre.images) {
                if (await (0, publishing_1.isImageUsable)(app.storage, image))
                    usableImages.add(image.id);
                else
                    app.log.warn({ productId: req.params.id, imageId: image.id }, 'product photo missing or unreadable in storage');
            }
        }
        const product = await app.prisma.$transaction(async (tx) => {
            const row = await (0, publishing_1.lockOwnedProduct)(tx, store.id, req.params.id);
            if (row.status === 'ARCHIVED')
                throw new httpError_1.HttpError(409, 'invalid_state', 'This product is archived and cannot be published.');
            if (row.status === 'PUBLISHED')
                return row; // already live: idempotent
            // Only photos verified above count. A photo row added after the check is simply not trusted yet.
            const usableCount = row.images.filter((i) => usableImages.has(i.id)).length;
            const issues = (0, publishing_1.getPublishIssues)(row, usableCount, { live: false });
            if (issues.length > 0) {
                const photoFileProblem = row.images.length > 0 && usableCount === 0;
                const fields = (0, publishing_1.issuesToFields)(issues);
                if (photoFileProblem)
                    fields.image = publishing_1.IMAGE_UNAVAILABLE_MESSAGE;
                const onlyPhoto = photoFileProblem && issues.length === 1;
                throw new httpError_1.HttpError(400, 'not_publishable', onlyPhoto ? publishing_1.IMAGE_UNAVAILABLE_MESSAGE : 'This product is not ready to publish yet.', fields);
            }
            return tx.product.update({ where: { id: row.id }, data: { status: 'PUBLISHED', publishedAt: new Date() }, include: { images: true } });
        });
        return { product: (0, dto_1.toProductDto)(product) };
    });
    // PUBLISHED -> DRAFT. The product is kept exactly as it is (price, stock, text); it just stops being visible.
    app.post('/api/seller/products/:id/unpublish', async (req) => {
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        const product = await app.prisma.$transaction(async (tx) => {
            const row = await (0, publishing_1.lockOwnedProduct)(tx, store.id, req.params.id);
            if (row.status === 'ARCHIVED')
                throw new httpError_1.HttpError(409, 'invalid_state', 'This product is archived.');
            if (row.status === 'DRAFT')
                return row; // already a draft: idempotent
            return tx.product.update({ where: { id: row.id }, data: { status: 'DRAFT', publishedAt: null }, include: { images: true } });
        });
        return { product: (0, dto_1.toProductDto)(product) };
    });
    // Re-runs Claude on the saved photo with the seller's answers. Overwrites ONLY the AI-owned fields
    // (title, description, category, tags, what's visible, open questions) and records the answers.
    // Price, stock, status and earlier notes/answers are preserved. If anything fails, nothing is changed.
    app.post('/api/seller/products/:id/regenerate', async (req) => {
        const body = regenerateBody.parse(req.body ?? {});
        const store = await (0, ownership_1.getSellerStore)(app.prisma, req.user.id);
        const product = await ownedProduct(req.user.id, req.params.id);
        if (product.status !== 'DRAFT') {
            throw new httpError_1.HttpError(409, 'invalid_state', 'Unpublish this product before regenerating its listing.');
        }
        // Answers may only address questions Claude actually asked (or ones the seller already answered).
        const facts = (0, sellerFacts_1.readSellerFacts)(product.sellerNotes);
        const asked = new Map((product.openQuestions ?? []).map((q) => [q.attribute, q.question]));
        const merged = { text: body.notes ?? facts.text, answers: { ...facts.answers } };
        const bad = {};
        for (const a of body.answers) {
            if (!asked.has(a.attribute) && !facts.answers[a.attribute]) {
                bad[`answers.${a.attribute}`] = 'This question is not part of this product.';
            }
            else if (a.answer) {
                merged.answers[a.attribute] = { question: asked.get(a.attribute) ?? facts.answers[a.attribute].question, answer: a.answer };
            } // a blank answer changes nothing: existing answers are never deleted by regeneration
        }
        if (Object.keys(bad).length)
            throw new httpError_1.HttpError(400, 'validation_error', 'Please check your answers.', bad);
        // Brand memory: always the CURRENT approved brand, read from PostgreSQL.
        const brand = await (0, service_1.getApprovedBrand)(app.prisma, store.id);
        const image = [...product.images].sort((a, b) => a.position - b.position)[0];
        let bytes;
        try {
            if (!image)
                throw new Error('no image row');
            bytes = await app.storage.get(image.storageKey);
        }
        catch {
            throw new httpError_1.HttpError(409, 'image_missing', 'The photo for this product could not be found, so the listing cannot be regenerated.');
        }
        await (0, client_1.enforceAiQuota)(app.prisma, app.config, store.id);
        const listing = await (0, listingService_1.generateListing)(app.ai, {
            model: app.config.CLAUDE_MODEL_SMART,
            storeId: store.id,
            brand,
            image: { base64: bytes.toString('base64'), mime: image.mimeType },
            notes: (0, sellerFacts_1.factsForPrompt)(merged),
            supportedFacts: (0, sellerFacts_1.factsForGuard)(merged),
            productId: product.id,
        });
        // Claude succeeded. Write in one transaction, re-checking the product is still a draft.
        const updated = await app.prisma.$transaction(async (tx) => {
            const row = await (0, publishing_1.lockOwnedProduct)(tx, store.id, product.id);
            if (row.status !== 'DRAFT')
                throw new httpError_1.HttpError(409, 'invalid_state', 'Unpublish this product before regenerating its listing.');
            return tx.product.update({
                where: { id: row.id },
                data: {
                    title: listing.title,
                    description: listing.description,
                    category: listing.category,
                    tags: [...new Set(listing.tags.map((t) => t.toLowerCase()))].slice(0, 10),
                    visibleCharacteristics: listing.visibleCharacteristics,
                    openQuestions: listing.openQuestions,
                    aiDraft: listing,
                    brandVersion: brand.version,
                    sellerNotes: merged,
                },
                include: { images: true },
            });
        });
        return { product: (0, dto_1.toProductDto)(updated) };
    });
    // Seller-only image access. (A public storefront image route comes with the storefront phase.)
    app.get('/api/seller/products/:id/image', async (req, reply) => {
        const product = await ownedProduct(req.user.id, req.params.id);
        const image = [...product.images].sort((a, b) => a.position - b.position)[0];
        if (!image)
            throw new httpError_1.HttpError(404, 'not_found', 'This product has no image.');
        let data;
        try {
            data = await app.storage.get(image.storageKey);
        }
        catch {
            throw new httpError_1.HttpError(404, 'not_found', 'Image file not found.');
        }
        return reply.header('Content-Type', image.mimeType).header('Cache-Control', 'private, max-age=3600').send(data);
    });
}
//# sourceMappingURL=routes.js.map