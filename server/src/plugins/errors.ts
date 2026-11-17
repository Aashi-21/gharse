import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { HttpError } from '../lib/httpError';

export function registerErrorHandling(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, fields: err.fields } });
    }
    if (err instanceof ZodError) {
      const fields: Record<string, string> = {};
      for (const issue of err.issues) {
        const key = issue.path.join('.') || '_';
        if (!fields[key]) fields[key] = issue.message;
      }
      return reply.code(400).send({ error: { code: 'validation_error', message: 'Please check the highlighted fields.', fields } });
    }
    // Fastify's own 4xx errors (bad JSON, payload too large, rate limit, unsupported media type...)
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const code = status === 429 ? 'rate_limited' : 'bad_request';
      const message = status === 429 ? 'Too many requests. Please wait a moment and try again.' : 'The request could not be understood.';
      return reply.code(status).send({ error: { code, message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong on our side. Please try again.' } });
  });
}
