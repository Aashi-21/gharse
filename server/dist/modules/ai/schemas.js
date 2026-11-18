"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listingSchema = exports.brandBriefSchema = exports.brandSuggestionSchema = exports.brandFieldsSchema = void 0;
const zod_1 = require("zod");
const categories_1 = require("../products/categories");
const hex = zod_1.z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour like #B5543A')
    .describe('6-digit hex colour, e.g. #B5543A');
/** The brand profile as stored and as edited by the seller. */
exports.brandFieldsSchema = zod_1.z.object({
    name: zod_1.z.string().trim().min(2, 'Enter a brand name').max(60).describe('The brand name'),
    tagline: zod_1.z.string().trim().min(3, 'Enter a tagline').max(120).describe('A short tagline, at most 10 words'),
    story: zod_1.z.string().trim().min(40, 'Write at least a couple of sentences').max(1500).describe('Brand story, 60-120 words (about 400-800 characters); never exceed 1000 characters'),
    primaryColor: hex.describe('Main brand colour as 6-digit hex. Must stay readable with white text on top of it.'),
    secondaryColor: hex.describe('Complementary accent colour as 6-digit hex'),
    tone: zod_1.z.string().trim().min(3, 'Describe the tone').max(200).describe('Brand voice in one short phrase, e.g. "Warm, festive and personal"'),
    personalityTraits: zod_1.z.array(zod_1.z.string().trim().min(2).max(30)).min(2, 'Add at least two traits').max(6).describe('3-5 single-word or two-word personality traits'),
    descriptionStyle: zod_1.z.string().trim().min(10, 'Describe the writing style').max(800).describe('How product descriptions should be written: sentence length, how to address the customer, what to emphasise, what to avoid. Aim for 250-400 characters; never exceed 600.'),
    visualGuidelines: zod_1.z.string().trim().min(10, 'Add visual guidelines').max(1000).describe('Photography and styling guidance for product photos and the storefront. Aim for 250-450 characters; never exceed 700.'),
});
/** What Claude returns: the brand plus name alternatives for the seller to choose from. */
exports.brandSuggestionSchema = exports.brandFieldsSchema.extend({
    nameOptions: zod_1.z.array(zod_1.z.string().trim().min(2).max(60)).min(3).max(5).describe('3-5 candidate brand names, including the one chosen as "name"'),
});
/** The seller's answers to the brand questionnaire. */
exports.brandBriefSchema = zod_1.z.object({
    productsMade: zod_1.z.string().trim().min(3, 'Tell us what you make').max(400),
    audience: zod_1.z.string().trim().min(3, 'Tell us who you make it for').max(300),
    preferredName: zod_1.z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), zod_1.z.string().trim().max(60).optional()),
    personality: zod_1.z.string().trim().min(3, 'Describe the feeling you want your brand to have').max(200),
});
/** What Claude returns for a product photo. Caps are deliberately well above the targets in each description. */
exports.listingSchema = zod_1.z.object({
    visibleCharacteristics: zod_1.z
        .array(zod_1.z.string().trim().min(2).max(160))
        .min(1)
        .max(12)
        .describe('3-8 short observations about what is CLEARLY VISIBLE in the photo: colours, shapes, patterns, visible parts, apparent finish. Never materials, sizes or anything not visible.'),
    title: zod_1.z.string().trim().min(2).max(120).describe('Product title, about 4-8 words (aim for under 70 characters). Plain and descriptive.'),
    description: zod_1.z.string().trim().min(20).max(1800).describe('Product description in the brand voice, about 40-90 words (roughly 250-600 characters). Only visible facts and seller-stated facts.'),
    category: zod_1.z.enum(categories_1.PRODUCT_CATEGORIES).describe('Best-fitting category from the allowed list'),
    tags: zod_1.z.array(zod_1.z.string().trim().min(1).max(40)).min(3).max(10).describe('4-8 short lowercase search tags (aim for under 20 characters each) describing the product type and visible features. No claims.'),
    openQuestions: zod_1.z
        .array(zod_1.z.object({
        attribute: zod_1.z.string().trim().min(2).max(40).describe('Short id of the missing fact, e.g. material, size, weight, scent, quantity, care, how_made'),
        question: zod_1.z.string().trim().min(5).max(300).describe('A plain-English question to the seller asking for that missing fact'),
    }))
        .max(10)
        .describe('3-6 questions about product facts that cannot be established from the photo or seller notes'),
});
//# sourceMappingURL=schemas.js.map