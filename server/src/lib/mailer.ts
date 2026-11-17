import nodemailer from 'nodemailer';
import type { Config } from '../config';

export interface Mailer {
  verify(): Promise<void>;
  send(opts: { subject: string; text: string; replyTo?: string }): Promise<void>;
}

/** Returns null when SMTP is not configured. */
export function createMailer(config: Config): Mailer | null {
  if (!config.SMTP_HOST) return null;
  const transport = nodemailer.createTransport({
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
