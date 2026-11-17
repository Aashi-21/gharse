import { z } from 'zod';

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex colour like #B5543A')
  .describe('6-digit hex colour, e.g. #B5543A');

/** The brand profile as stored and as edited by the seller. */
export const brandFieldsSchema = z.object({
  name: z.string().trim().min(2, 'Enter a brand name').max(60).describe('The brand name'),
  tagline: z.string().trim().min(3, 'Enter a tagline').max(120).describe('A short tagline, at most 10 words'),
  story: z.string().trim().min(40, 'Write at least a couple of sentences').max(1500).describe('Brand story, 60-120 words (about 400-800 characters); never exceed 1000 characters'),
  primaryColor: hex.describe('Main brand colour as 6-digit hex. Must stay readable with white text on top of it.'),
  secondaryColor: hex.describe('Complementary accent colour as 6-digit hex'),
  tone: z.string().trim().min(3, 'Describe the tone').max(200).describe('Brand voice in one short phrase, e.g. "Warm, festive and personal"'),
  personalityTraits: z.array(z.string().trim().min(2).max(30)).min(2, 'Add at least two traits').max(6).describe('3-5 single-word or two-word personality traits'),
  descriptionStyle: z.string().trim().min(10, 'Describe the writing style').max(800).describe('How product descriptions should be written: sentence length, how to address the customer, what to emphasise, what to avoid. Aim for 250-400 characters; never exceed 600.'),
  visualGuidelines: z.string().trim().min(10, 'Add visual guidelines').max(1000).describe('Photography and styling guidance for product photos and the storefront. Aim for 250-450 characters; never exceed 700.'),
});
export type BrandFields = z.infer<typeof brandFieldsSchema>;

/** What Claude returns: the brand plus name alternatives for the seller to choose from. */
export const brandSuggestionSchema = brandFieldsSchema.extend({
  nameOptions: z.array(z.string().trim().min(2).max(60)).min(3).max(5).describe('3-5 candidate brand names, including the one chosen as "name"'),
});
export type BrandSuggestion = z.infer<typeof brandSuggestionSchema>;

/** The seller's answers to the brand questionnaire. */
export const brandBriefSchema = z.object({
  productsMade: z.string().trim().min(3, 'Tell us what you make').max(400),
  audience: z.string().trim().min(3, 'Tell us who you make it for').max(300),
  preferredName: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().max(60).optional()),
  personality: z.string().trim().min(3, 'Describe the feeling you want your brand to have').max(200),
});
export type BrandBrief = z.infer<typeof brandBriefSchema>;
