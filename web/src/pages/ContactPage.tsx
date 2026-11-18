import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, Field, Input, Logo, Textarea } from '../components/ui';
import { api, ApiError } from '../lib/api';

const MAX_MESSAGE = 2000;
const empty = { name: '', email: '', subject: '', message: '', website: '' };

/**
 * Public contact form. It only ever says "sent" after the server confirms the mail server accepted the message;
 * on any failure the visitor's text is kept so nothing is lost.
 */
export default function ContactPage() {
  const [f, setF] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});

  useEffect(() => {
    document.title = 'Contact GharSe';
    return () => {
      document.title = 'GharSe — your handmade brand, online';
    };
  }, []);

  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return; // guards against double-clicks
    setBusy(true);
    setError('');
    setFields({});
    try {
      const r = await api<{ sent?: boolean }>('/api/contact', { method: 'POST', body: f });
      if (r?.sent === true) {
        setSent(true);
        setF(empty);
      } else {
        // Anything other than an explicit confirmation is treated as a failure.
        setError('We could not confirm that your message was sent. Please try again.');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-5 py-5">
        <Logo />
        <Link to="/" className="rounded-full px-4 py-2.5 text-sm font-medium text-ink-soft hover:bg-cream-200">Home</Link>
      </header>

      <main className="mx-auto max-w-xl px-5 pb-16 pt-4">
        <h1 className="text-3xl font-semibold sm:text-4xl">Contact GharSe</h1>
        <p className="mt-2 text-ink-soft">
          Questions about GharSe, or want to tell us about your experience? Send us a message and we will reply to the email address you give.
        </p>
        <p className="mt-1 text-sm text-ink-faint">Looking for a seller? Use the contact details on their store page.</p>

        {sent ? (
          <Card className="mt-6" >
            <div role="status" className="space-y-3">
              <Alert kind="success">
                <strong>Message sent.</strong> Thank you for writing to us. We will reply to the email address you provided.
              </Alert>
              <Button type="button" variant="secondary" onClick={() => setSent(false)}>Send another message</Button>
            </div>
          </Card>
        ) : (
          <Card className="mt-6">
            <form onSubmit={submit} className="space-y-4" noValidate aria-label="Contact form">
              {error && <Alert>{error}</Alert>}

              <Field label="Your name" error={fields.name}>
                <Input value={f.name} onChange={set('name')} autoComplete="name" maxLength={80} required />
              </Field>
              <Field label="Your email" error={fields.email} hint="We will reply here. We do not share it.">
                <Input type="email" value={f.email} onChange={set('email')} autoComplete="email" inputMode="email" maxLength={254} required />
              </Field>
              <Field label="Subject" error={fields.subject}>
                <Input value={f.subject} onChange={set('subject')} maxLength={120} required />
              </Field>
              <Field label="Message" error={fields.message} hint={`${f.message.length} / ${MAX_MESSAGE} characters`}>
                <Textarea rows={6} value={f.message} onChange={set('message')} maxLength={MAX_MESSAGE} required />
              </Field>

              {/* Honeypot: hidden from people, often filled in by bots. */}
              <div className="absolute -left-[9999px] h-0 w-0 overflow-hidden" aria-hidden="true">
                <label>Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} /></label>
              </div>

              <p className="text-xs text-ink-faint">
                Your name, email address and message are used only to reply to you.
              </p>
              <Button type="submit" loading={busy} className="w-full sm:w-auto">Send message</Button>
            </form>
          </Card>
        )}
      </main>
    </div>
  );
}
