import type { Config } from '../config';
import { sendEmail } from './emailGateway';

export interface Mailer {
  send(opts: { subject: string; text: string; replyTo?: string }): Promise<void>;
}

/**
 * Uses GoDaddy's built-in Node.js Hosting email gateway.
 * Returns null when the contact recipient is not configured.
 */
export function createMailer(config: Config): Mailer | null {
  if (!config.CONTACT_TO) return null;

  return {
    /**
     * The GoDaddy gateway does not expose an SMTP-style verify operation.
     * Health-check handling will be updated separately.
     */

    async send({ subject, text, replyTo }) {
      await sendEmail({
        to: config.CONTACT_TO!,
        subject,
        text,
        replyTo,
        // Omit `from`: GoDaddy selects the canonical sender identity.
      });
    },
  };
}