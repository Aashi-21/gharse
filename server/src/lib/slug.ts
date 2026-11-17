import { z } from 'zod';

const RESERVED = new Set([
  'api', 'admin', 'store', 'stores', 'login', 'register', 'logout', 'dashboard', 'onboarding',
  'contact', 'about', 'help', 'support', 'static', 'assets', 'uploads', 'health', 'gharse', 'www',
]);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Use at least 3 characters')
  .max(40, 'Use at most 40 characters')
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use only lowercase letters, numbers and single hyphens')
  .refine((s) => !RESERVED.has(s), 'This address is reserved, please choose another');
