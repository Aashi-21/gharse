import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { INDIAN_STATES } from '../lib/india';
import type { Profile } from '../lib/auth';
import { Alert, Button, Field, Input, Select, Textarea } from './ui';

export default function ProfileForm({
  initial,
  submitLabel,
  onSaved,
}: {
  initial: Profile | null;
  submitLabel: string;
  onSaved: () => void | Promise<void>;
}) {
  const [v, setV] = useState({
    fullName: initial?.fullName ?? '',
    phone: initial?.phone ?? '',
    whatsapp: initial?.whatsapp ?? '',
    city: initial?.city ?? '',
    state: initial?.state ?? '',
    bio: initial?.bio ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => {
    setSaved(false);
    setV((p) => ({ ...p, [k]: e.target.value }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFields({});
    setSaved(false);
    try {
      await api('/api/seller/profile', { method: 'PUT', body: v });
      setSaved(true);
      await onSaved();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFields(err.fields);
      } else setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert>{error}</Alert>}
      {saved && !error && <Alert kind="success">Saved.</Alert>}
      <Field label="Your name" error={fields.fullName}>
        <Input value={v.fullName} onChange={set('fullName')} autoComplete="name" placeholder="Riya Sharma" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Mobile number" error={fields.phone} hint="Customers and orders will reach you here">
          <Input value={v.phone} onChange={set('phone')} inputMode="tel" autoComplete="tel" placeholder="98765 43210" />
        </Field>
        <Field label="WhatsApp number (optional)" error={fields.whatsapp} hint="Leave blank if same as mobile">
          <Input value={v.whatsapp} onChange={set('whatsapp')} inputMode="tel" />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="City" error={fields.city}>
          <Input value={v.city} onChange={set('city')} autoComplete="address-level2" />
        </Field>
        <Field label="State" error={fields.state}>
          <Select value={v.state} onChange={set('state')}>
            <option value="">Select state</option>
            {INDIAN_STATES.map((s) => <option key={s}>{s}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="About you (optional)" error={fields.bio} hint="A line or two about what you make and why">
        <Textarea rows={3} value={v.bio} onChange={set('bio')} />
      </Field>
      <Button type="submit" loading={busy}>{submitLabel}</Button>
    </form>
  );
}
