import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const repoRoot = path.resolve(__dirname, '..', '..');

// Load repo-root .env if present. Real environment variables always win (loadEnvFile does not override).
const envFile = path.join(repoRoot, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const bool = z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    HOST: z.string().default('0.0.0.0'),
    APP_URL: z.string().url().default('http://localhost:3000'),
    TRUST_PROXY: bool,
    DATABASE_URL: z
      .string({ error: 'DATABASE_URL is required' })
      .regex(/^postgres(ql)?:\/\//, 'must start with postgresql://'),
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(10),
    STORAGE_DRIVER: z.enum(['local']).default('local'),
    UPLOAD_DIR: z.string().default('uploads'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_SECURE: bool,
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    MAIL_FROM: z.string().optional(),
    CONTACT_TO: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    CLAUDE_MODEL_SMART: z.string().default('claude-sonnet-5-5'),
    CLAUDE_MODEL_FAST: z.string().default('claude-haiku-5-5'),
    AI_TIMEOUT_MS: z.coerce.number().int().min(5000).max(300000).default(90000),
    // Per-seller abuse/cost guards, counted from ai_generations (every attempt, including failures).
    AI_HOURLY_LIMIT: z.coerce.number().int().min(1).default(20),
    AI_DAILY_LIMIT: z.coerce.number().int().min(1).default(100),
  })
  .superRefine((v, ctx) => {
    if (v.SMTP_HOST) {
      for (const k of ['MAIL_FROM', 'CONTACT_TO'] as const) {
        if (!v[k]) ctx.addIssue({ code: 'custom', path: [k], message: 'required when SMTP_HOST is set' });
      }
      if (!!v.SMTP_USER !== !!v.SMTP_PASS) {
        ctx.addIssue({ code: 'custom', path: ['SMTP_USER'], message: 'SMTP_USER and SMTP_PASS must be set together' });
      }
    }
  });

export type Config = z.infer<typeof schema> & {
  isProd: boolean;
  /** absolute path of the local upload directory */
  uploadDir: string;
  /** cookies get the Secure flag only when the public URL is https */
  cookieSecure: boolean;
};

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings (e.g. "SMTP_HOST=" in .env) as unset.
  const raw = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(config)'}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${lines.join('\n')}\nSee .env.example`);
  }
  const c = parsed.data;
  return {
    ...c,
    isProd: c.NODE_ENV === 'production',
    uploadDir: path.resolve(repoRoot, c.UPLOAD_DIR),
    cookieSecure: c.APP_URL.startsWith('https://'),
  };
}
