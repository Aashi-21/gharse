/**
 * Live smoke test of the Claude integration. Makes ONE real Sonnet brand-generation call
 * (a few cents) through the same service the app uses, then validates the result.
 *
 *   npm run ai:smoke            (from the repo root)
 *
 * Reads ANTHROPIC_API_KEY from the root .env (or the environment). The key is never printed.
 * No database is required: usage rows are captured in memory instead of being written.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { PrismaClient } from '@prisma/client';
import { loadConfig } from '../src/config';
import { HttpError } from '../src/lib/httpError';
import { generateBrand } from '../src/modules/ai/brandService';
import { createAiClient } from '../src/modules/ai/client';
import { brandSuggestionSchema } from '../src/modules/ai/schemas';

const line = (s = '') => console.log(s);

async function main() {
  // DATABASE_URL is required by the config schema but unused here.
  const config = loadConfig({ DATABASE_URL: 'postgresql://unused:unused@localhost/unused', ...process.env });
  const key = config.ANTHROPIC_API_KEY;

  if (!key) {
    console.error('ANTHROPIC_API_KEY is not set.\nAdd it to the root .env file (ANTHROPIC_API_KEY=sk-ant-...) and run again.');
    return 2;
  }
  line(`ANTHROPIC_API_KEY: present (${key.length} characters, value hidden)`);
  if (!key.startsWith('sk-ant-')) line('  warning: key does not start with "sk-ant-" — it may be mistyped or not an Anthropic key.');
  line(`Model: ${config.CLAUDE_MODEL_SMART}`);
  line('Sending one real brand-generation request…\n');

  const scrub = (s: string) => s.split(key).join('[redacted]');

  // Captured instead of persisted / hidden:
  const usageRows: { model: string; status: string; errorCode?: string | null; inputTokens?: number | null; outputTokens?: number | null; latencyMs?: number | null }[] = [];
  const upstreamErrors: unknown[] = [];
  const rejections: string[] = [];
  const prismaCapture = {
    aiGeneration: { create: async ({ data }: { data: (typeof usageRows)[number] }) => void usageRows.push(data) },
  } as unknown as PrismaClient;
  const log = {
    info: () => {},
    warn: (obj: unknown, msg?: string) => {
      const why = (obj as { why?: string[] })?.why;
      if (why) rejections.push(...why.map((w) => `${msg}: ${w}`));
    },
    error: (obj: unknown) => {
      const err = (obj as { err?: unknown })?.err;
      if (err) upstreamErrors.push(err);
    },
  } as never;

  const ai = createAiClient(config, prismaCapture, log);
  try {
    const brand = await generateBrand(ai, {
      model: config.CLAUDE_MODEL_SMART,
      storeId: 'smoke-test',
      brief: {
        productsMade: 'Hand-poured soy candles and wax melts',
        audience: 'Young professionals who love a cosy home',
        personality: 'Warm, calm, earthy',
      },
    });

    // generateBrand already validates inside the client; check again explicitly so this script proves it.
    const check = brandSuggestionSchema.safeParse(brand);
    if (!check.success) {
      console.error('FAILED: result does not match brandSuggestionSchema:', check.error.issues);
      return 1;
    }

    line('=== Generated brand (validated) ===');
    line(JSON.stringify(brand, null, 2));
    line('\n=== Usage ===');
    for (const [i, r] of usageRows.entries()) {
      line(`attempt ${i + 1}: model=${r.model} status=${r.status} input_tokens=${r.inputTokens} output_tokens=${r.outputTokens} latency=${r.latencyMs}ms`);
    }
    const inTok = usageRows.reduce((n, r) => n + (r.inputTokens ?? 0), 0);
    const outTok = usageRows.reduce((n, r) => n + (r.outputTokens ?? 0), 0);
    line(`total: ${inTok} input + ${outTok} output tokens across ${usageRows.length} attempt(s)`);
    if (usageRows.length > 1) line('note: more than one attempt means the first answer was invalid and was retried.');
    line('\nPASS — real Claude call succeeded and the response passed schema validation.');
    return 0;
  } catch (err) {
    console.error('FAILED\n');
    console.error(scrub(explain(err, upstreamErrors, usageRows)));
    if (rejections.length) console.error('\nValidation details:\n' + rejections.map((r) => '  - ' + r).join('\n'));
    return 1;
  }
}

/** Turns a failure into a plain-language diagnosis. Prefers the raw upstream error over the app's safe message. */
function explain(err: unknown, upstream: unknown[], rows: { status: string; errorCode?: string | null }[]): string {
  const raw = upstream[upstream.length - 1] ?? err;
  const detail = raw instanceof Error ? raw.message : String(raw);

  if (raw instanceof Anthropic.AuthenticationError) {
    return `Authentication failed (HTTP 401): the API key was rejected. It may be mistyped, revoked, or from a different organisation.\nCreate or copy a key at https://console.anthropic.com/settings/keys\nUpstream: ${detail}`;
  }
  if (raw instanceof Anthropic.PermissionDeniedError) {
    return `Permission denied (HTTP 403): this key is not allowed to use model "${process.env.CLAUDE_MODEL_SMART ?? 'claude-sonnet-5-5'}" or the feature.\nUpstream: ${detail}`;
  }
  if (raw instanceof Anthropic.BadRequestError && /credit balance|billing|purchase credits/i.test(detail)) {
    return `Insufficient credits: the account balance is too low (or billing is not set up).\nAdd credits at https://console.anthropic.com/settings/billing\nUpstream: ${detail}`;
  }
  if (raw instanceof Anthropic.RateLimitError) {
    return `Rate limited (HTTP 429): too many requests or tokens right now. Wait a minute and run again.\nUpstream: ${detail}`;
  }
  if (raw instanceof Anthropic.BadRequestError || raw instanceof Anthropic.UnprocessableEntityError) {
    return `The API rejected the request (HTTP ${(raw as { status?: number }).status}). This usually means an unsupported parameter, model name or schema — a real bug to fix, not a setup problem.\nUpstream: ${detail}`;
  }
  if (raw instanceof Anthropic.NotFoundError) {
    return `Not found (HTTP 404): the model name is probably wrong or not available to this key.\nUpstream: ${detail}`;
  }
  if (raw instanceof Anthropic.APIConnectionTimeoutError) {
    return `Network timeout: no response from api.anthropic.com in time. Check your connection / VPN / firewall and try again.\nUpstream: ${detail}`;
  }
  if (raw instanceof Anthropic.APIConnectionError) {
    return `Network error: could not connect to api.anthropic.com. Check your internet connection, DNS, proxy or firewall.\nUpstream: ${detail}`;
  }
  if (raw instanceof Anthropic.APIError && (raw.status ?? 0) >= 500) {
    return `Anthropic service problem (HTTP ${raw.status}). Not your configuration — try again shortly.\nUpstream: ${detail}`;
  }
  if (err instanceof HttpError && err.code === 'ai_invalid_output') {
    const bad = rows.filter((r) => r.status === 'INVALID_OUTPUT').map((r) => r.errorCode).join(', ');
    return `Invalid structured output: Claude replied twice but the answer failed schema validation (${bad}).\nThis is a prompt/schema issue to investigate.`;
  }
  if (err instanceof HttpError && err.code === 'ai_refused') {
    return 'Claude declined this request (stop_reason: refusal). Unexpected for a candle brand brief — investigate.';
  }
  if (err instanceof HttpError) return `${err.code}: ${err.message}\nUpstream: ${detail}`;
  return `Unexpected error: ${detail}`;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('Unexpected failure:', e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
