"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorLogPayload = errorLogPayload;
exports.registerErrorHandling = registerErrorHandling;
const zod_1 = require("zod");
const httpError_1 = require("../lib/httpError");
/**
 * What may be logged for an unexpected error. Errors raised while handling sensitive public POSTs can carry personal
 * data (ORM errors often embed the query arguments), so for those only the error's class and code are logged,
 * never its message, stack or arguments.
 */
function errorLogPayload(err, method, url) {
    // Public checkout carries customer details; the contact form carries a visitor's name, email and message
    // (mail-server errors also tend to quote email addresses).
    const sensitive = method === 'POST' && (/^\/api\/public\/stores\/[^/]+\/orders/.test(url) || /^\/api\/contact(\?|$)/.test(url));
    if (!sensitive)
        return { err };
    const e = err;
    return { errName: e?.name ?? 'Error', errCode: e?.code };
}
function registerErrorHandling(app) {
    app.setErrorHandler((err, req, reply) => {
        if (err instanceof httpError_1.HttpError) {
            return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, fields: err.fields } });
        }
        if (err instanceof zod_1.ZodError) {
            const fields = {};
            for (const issue of err.issues) {
                const key = issue.path.join('.') || '_';
                if (!fields[key])
                    fields[key] = issue.message;
            }
            return reply.code(400).send({ error: { code: 'validation_error', message: 'Please check the highlighted fields.', fields } });
        }
        // Fastify's own 4xx errors (bad JSON, payload too large, rate limit, unsupported media type...)
        const status = err.statusCode;
        if (status && status >= 400 && status < 500) {
            const code = status === 429 ? 'rate_limited' : 'bad_request';
            const message = status === 429 ? 'Too many requests. Please wait a moment and try again.' : 'The request could not be understood.';
            return reply.code(status).send({ error: { code, message } });
        }
        req.log.error(errorLogPayload(err, req.method, req.url), 'unhandled error');
        return reply.code(500).send({ error: { code: 'internal_error', message: 'Something went wrong on our side. Please try again.' } });
    });
}
//# sourceMappingURL=errors.js.map