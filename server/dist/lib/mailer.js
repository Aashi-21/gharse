"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMailer = createMailer;
const nodemailer_1 = __importDefault(require("nodemailer"));
/** Returns null when SMTP is not configured. */
function createMailer(config) {
    if (!config.SMTP_HOST)
        return null;
    const transport = nodemailer_1.default.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE,
        auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
        connectionTimeout: 5000,
        greetingTimeout: 5000,
        socketTimeout: 8000,
    });
    return {
        async verify() {
            await transport.verify();
        },
        async send({ subject, text, replyTo }) {
            await transport.sendMail({ from: config.MAIL_FROM, to: config.CONTACT_TO, subject, text, replyTo });
        },
    };
}
//# sourceMappingURL=mailer.js.map