"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contactSchema = void 0;
exports.buildContactEmail = buildContactEmail;
exports.contactRoutes = contactRoutes;
const zod_1 = require("zod");
const httpError_1 = require("../../lib/httpError");
// Control characters (CR/LF in particular) must never reach an email header: that is how header injection works.
const HAS_CONTROL = /[\u0000-\u001f\u007f]/;
// The message body may contain line breaks and tabs, but no other control characters.
const HAS_BAD_BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/**
 * Strict: any field that is not listed here is refused. The honeypot `website` must stay empty:
 * people never see it, many bots fill it in.
 */
exports.contactSchema = zod_1.z.strictObject({
    name: zod_1.z.string({ error: 'Enter your name' }).trim().min(2, 'Enter your name').max(80, 'Keep your name under 80 characters').refine((s) => !HAS_CONTROL.test(s), 'Please remove special characters from your name'),
    email: zod_1.z.string({ error: 'Enter your email address' }).trim().max(254, 'This email address is too long').pipe(zod_1.z.email('Enter a valid email address')),
    subject: zod_1.z.string({ error: 'Enter a subject' }).trim().min(3, 'Enter a subject').max(120, 'Keep the subject under 120 characters').refine((s) => !HAS_CONTROL.test(s), 'Please remove line breaks from the subject'),
    message: zod_1.z.string({ error: 'Write your message' }).trim().min(10, 'Write at least 10 characters').max(2000, 'Keep your message under 2000 characters').refine((s) => !HAS_BAD_BODY_CONTROL.test(s), 'Your message contains characters we cannot accept'),
    website: zod_1.z.string().max(0, 'Invalid request').optional(),
});
const withTimeout = (p, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('mail send timed out')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
/** What the site owner receives. Plain text only, so nothing the visitor typed is ever interpreted as markup. */
function buildContactEmail(i, now = new Date()) {
    return {
        subject: `[GharSe contact] ${i.subject}`,
        // Reply goes straight to the visitor. The address was validated above and contains no control characters.
        replyTo: i.email,
        text: [
            'New message from the GharSe contact form.',
            'Reply to this email to answer the sender directly.',
            '',
            `Name:    ${i.name}`,
            `Email:   ${i.email}`,
            `Subject: ${i.subject}`,
            `Sent:    ${now.toISOString()}`,
            '',
            i.message,
            '',
        ].join('\n'),
    };
}
/**
 * Public contact form: POST /api/contact. Delivery uses the app's existing mailer (SMTP settings come only from the
 * server environment; nothing about the recipient or SMTP is ever sent to the browser).
 *
 * "sent" is returned ONLY after the mail server accepted the message. If mail is not configured the form answers
 * 503, if delivery fails 502, and never pretends otherwise. Names, addresses and message text are never logged.
 */
async function contactRoutes(app) {
    app.addHook('onSend', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store');
    });
    // Process-wide cap so a flood from many addresses cannot fill the owner's mailbox (resets when the process restarts).
    const recent = [];
    const overGlobalCap = () => {
        const cutoff = Date.now() - 3_600_000;
        while (recent.length && recent[0] < cutoff)
            recent.shift();
        if (recent.length >= app.config.CONTACT_HOURLY_LIMIT)
            return true;
        recent.push(Date.now());
        return false;
    };
    app.post('/api/contact', {
        bodyLimit: 16 * 1024, // generous for 2000 characters of any script, far below the app-wide default
        config: { rateLimit: { max: app.config.CONTACT_RATE_LIMIT_MAX, timeWindow: '1 hour' } },
    }, async (req, reply) => {
        const input = exports.contactSchema.parse(req.body);
        if (!app.mailer) {
            // Deliberately vague: do not reveal which setting is missing.
            req.log.warn('contact form used but email delivery is not configured');
            throw new httpError_1.HttpError(503, 'contact_unavailable', 'The contact form is not available right now. Please try again later.');
        }
        if (overGlobalCap()) {
            throw new httpError_1.HttpError(429, 'contact_busy', 'We are receiving a lot of messages right now. Please try again in a little while.');
        }
        try {
            await withTimeout(app.mailer.send(buildContactEmail(input)), app.config.CONTACT_SEND_TIMEOUT_MS);
        }
        catch (err) {
            // Mail-server errors often quote the recipient or sender address, so log only the error's class and code.
            req.log.error({ errName: err?.name, errCode: err?.code }, 'contact email delivery failed');
            throw new httpError_1.HttpError(502, 'contact_failed', 'We could not send your message right now. Please try again in a few minutes.');
        }
        return reply.code(200).send({ sent: true });
    });
}
//# sourceMappingURL=routes.js.map