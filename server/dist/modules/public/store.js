"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSlug = exports.notFound = void 0;
exports.findPublicStore = findPublicStore;
const httpError_1 = require("../../lib/httpError");
const notFound = () => new httpError_1.HttpError(404, 'not_found', 'Not found.');
exports.notFound = notFound;
// Store and product slugs are generated lowercase a-z, 0-9 and single hyphens. Anything else (NUL bytes, slashes,
// spaces, huge strings) can never match, so it is a 404 before the database is touched.
const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const isSlug = (s, max) => s.length <= max && SLUG_SHAPE.test(s);
exports.isSlug = isSlug;
/** The one way public routes find a store: published AND with an approved brand, else the same generic 404. */
async function findPublicStore(prisma, slugRaw) {
    const slug = slugRaw.toLowerCase();
    if (!(0, exports.isSlug)(slug, 40))
        throw (0, exports.notFound)();
    const store = await prisma.store.findFirst({ where: { slug, isPublished: true }, include: { brandProfile: true } });
    if (!store || !store.brandProfile || store.brandProfile.status !== 'APPROVED')
        throw (0, exports.notFound)();
    return { ...store, brandProfile: store.brandProfile };
}
//# sourceMappingURL=store.js.map