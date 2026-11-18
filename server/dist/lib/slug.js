"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.slugSchema = void 0;
exports.slugify = slugify;
const zod_1 = require("zod");
const RESERVED = new Set([
    'api', 'admin', 'store', 'stores', 'login', 'register', 'logout', 'dashboard', 'onboarding',
    'contact', 'about', 'help', 'support', 'static', 'assets', 'uploads', 'health', 'gharse', 'www',
]);
exports.slugSchema = zod_1.z
    .string()
    .trim()
    .toLowerCase()
    .min(3, 'Use at least 3 characters')
    .max(40, 'Use at most 40 characters')
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use only lowercase letters, numbers and single hyphens')
    .refine((s) => !RESERVED.has(s), 'This address is reserved, please choose another');
/** "Hand-painted Diya Set!" -> "hand-painted-diya-set" (ASCII, max 50 chars). Falls back to "product". */
function slugify(text) {
    const s = text
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50)
        .replace(/-+$/g, '');
    return s || 'product';
}
//# sourceMappingURL=slug.js.map