/**
 * LOCAL DEVELOPMENT ONLY: a fake SMTP server that prints every email it receives. Lets you try the contact form end to
 * end without any real mailbox. It accepts anything from 127.0.0.1 and delivers nothing anywhere.
 *
 *   npm run smtp:sink                 (listens on 127.0.0.1:2525)
 *
 * Then start the app with these (fake, local-only) settings in your shell or .env:
 *   SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_SECURE=false MAIL_FROM=no-reply@localhost.test CONTACT_TO=owner@localhost.test
 */
import { startSmtpSink } from '../test/smtpSink';

const port = Number(process.argv[2] ?? 2525);
startSmtpSink({
  port,
  onMessage: (m) => {
    console.log('\n=== email received ===');
    console.log(`envelope from: ${m.from}  to: ${m.to.join(', ')}`);
    console.log(m.data);
    console.log('=== end ===');
  },
}).then(
  (s) => console.log(`SMTP sink listening on 127.0.0.1:${s.port} (local development only; nothing is delivered anywhere)`),
  (e) => {
    console.error('Could not start the sink:', e.message);
    process.exit(1);
  },
);
