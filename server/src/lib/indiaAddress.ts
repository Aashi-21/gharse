import { z } from 'zod';

/** Indian mobile: accepts "98765 43210", "+91 98765-43210", "09876543210"; normalises to 10 digits. */
export const indianPhone = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))
  .refine((s) => /^[6-9]\d{9}$/.test(s), 'Enter a valid 10-digit Indian mobile number');

/** 6 digits, first digit 1-9 (India Post PIN codes never start with 0). */
export const indianPincode = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code');

// Keep in sync with web/src/lib/india.ts.
export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
  'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
] as const;
