import Anthropic from '@anthropic-ai/sdk';
import type { AiKind, AiStatus, PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config';
import { HttpError } from '../../lib/httpError';

export interface StructuredRequest<T> {
  kind: AiKind;
  model: string;
  system: string;
  content: Anthropic.MessageParam['content'];
  schema: z.ZodType<T>;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  /** audit / quota context */
  storeId: string;
  productId?: string;
  brandVersion?: number;
}

/** The only thing the rest of the app knows about Claude. Tests substitute a fake. */
export interface AiClient {
  configured: boolean;
  structured<T>(req: StructuredRequest<T>): Promise<T>;
}

// Keywords the structured-output API does not accept; zod still enforces them after the response arrives.
const UNSUPPORTED = new Set([
  '$schema', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minItems', 'maxItems', 'pattern', 'format', 'default',
]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) if (!UNSUPPORTED.has(k)) out[k] = sanitize(v);
    if (out.type === 'object') out.additionalProperties = false;
    return out;
  }
  return node;
}

/** Derives the JSON schema sent to Claude from the zod schema, so there is one source of truth. */
export function toApiSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitize(z.toJSONSchema(schema)) as Record<string, unknown>;
}

function mapApiError(err: unknown): HttpError {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new HttpError(504, 'ai_timeout', 'The AI assistant took too long to respond. Please try again.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new HttpError(502, 'ai_unavailable', 'We could not reach the AI assistant. Please try again in a moment.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new HttpError(429, 'ai_busy', 'The AI assistant is very busy right now. Please wait a minute and try again.');
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new HttpError(503, 'ai_not_configured', 'AI features are temporarily unavailable.');
  }
  if (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500) {
    return new HttpError(502, 'ai_unavailable', 'The AI assistant is temporarily unavailable. Please try again in a moment.');
  }
  return new HttpError(502, 'ai_request_failed', 'The AI assistant could not complete this request. Please try again.');
}

export function createAiClient(config: Config, prisma: PrismaClient, log: FastifyBaseLogger): AiClient {
  const sdk = config.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, timeout: config.AI_TIMEOUT_MS, maxRetries: config.AI_MAX_RETRIES })
    : null;

  async function record(req: StructuredRequest<unknown>, r: {
    status: AiStatus; latencyMs: number; errorCode?: string;
    inputTokens?: number; outputTokens?: number; output?: unknown;
  }) {
    log.info(
      { kind: req.kind, model: req.model, status: r.status, errorCode: r.errorCode, latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens },
      'claude call',
    );
    try {
      await prisma.aiGeneration.create({
        data: {
          storeId: req.storeId, kind: req.kind, model: req.model, status: r.status, errorCode: r.errorCode,
          latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
          productId: req.productId, brandVersion: req.brandVersion,
          outputJson: r.output === undefined ? undefined : (r.output as object),
        },
      });
    } catch (err) {
      log.error({ err }, 'failed to record ai_generation'); // never let audit logging break the request
    }
  }

  return {
    configured: !!sdk,
    async structured<T>(req: StructuredRequest<T>): Promise<T> {
      if (!sdk) throw new HttpError(503, 'ai_not_configured', 'AI features are not set up on this server yet.');
      const jsonSchema = toApiSchema(req.schema);

      // Two attempts, only for malformed/invalid output. Transport errors are already retried by the SDK.
      for (let attempt = 1; attempt <= 2; attempt++) {
        const started = Date.now();
        let resp: Anthropic.Message;
        try {
          resp = await sdk.messages.create({
            model: req.model,
            max_tokens: req.maxTokens ?? 4096,
            system: req.system,
            messages: [{ role: 'user', content: req.content }],
            output_config: { effort: req.effort ?? 'medium', format: { type: 'json_schema', schema: jsonSchema } },
          });
        } catch (err) {
          const mapped = mapApiError(err);
          log.error({ err, kind: req.kind }, 'claude api error');
          await record(req, { status: 'ERROR', latencyMs: Date.now() - started, errorCode: mapped.code });
          throw mapped;
        }
        const usage = { latencyMs: Date.now() - started, inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens };

        if (resp.stop_reason === 'refusal') {
          await record(req, { ...usage, status: 'ERROR', errorCode: 'refusal' });
          throw new HttpError(422, 'ai_refused', 'The AI assistant could not help with this request. Try rewording it.');
        }

        const text = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
        let parsed: z.ZodSafeParseResult<T> | null = null;
        if (resp.stop_reason !== 'max_tokens') {
          try {
            parsed = req.schema.safeParse(JSON.parse(text));
          } catch {
            parsed = null;
          }
        }
        if (parsed?.success) {
          await record(req, { ...usage, status: 'SUCCESS', output: parsed.data });
          return parsed.data;
        }
        // Log WHY it was rejected (field paths/messages only, never the key) so prompt/schema bugs are diagnosable.
        const why = parsed && !parsed.success
          ? parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          : [resp.stop_reason === 'max_tokens' ? 'truncated at max_tokens' : `not valid JSON (stop_reason=${resp.stop_reason}, ${text.length} chars)`];
        log.warn({ kind: req.kind, attempt, why }, 'claude output rejected');
        await record(req, { ...usage, status: 'INVALID_OUTPUT', errorCode: resp.stop_reason === 'max_tokens' ? 'max_tokens' : 'invalid_json_or_schema' });
      }
      throw new HttpError(502, 'ai_invalid_output', 'The AI assistant returned an unusable answer. Please try again.');
    },
  };
}

/** Per-seller hourly/daily caps, counted from the audit table (every attempt counts, even failures). */
export async function enforceAiQuota(prisma: PrismaClient, config: Config, storeId: string) {
  const now = Date.now();
  const [hour, day] = await Promise.all([
    prisma.aiGeneration.count({ where: { storeId, createdAt: { gte: new Date(now - 3_600_000) } } }),
    prisma.aiGeneration.count({ where: { storeId, createdAt: { gte: new Date(now - 86_400_000) } } }),
  ]);
  if (hour >= config.AI_HOURLY_LIMIT || day >= config.AI_DAILY_LIMIT) {
    throw new HttpError(429, 'ai_quota', 'You have reached the limit of AI generations for now. Please try again later.');
  }
}
