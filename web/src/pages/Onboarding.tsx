import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import ProfileForm from '../components/ProfileForm';
import { Alert, Button, Card, Field, Input, Logo } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth, useMe } from '../lib/auth';

type Check = { state: 'idle' } | { state: 'checking' } | { state: 'ok' } | { state: 'bad'; reason: string };

function StoreAddressStep() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [slug, setSlug] = useState('');
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Debounced availability check against the server (the server is the source of truth).
  useEffect(() => {
    if (!slug) return setCheck({ state: 'idle' });
    setCheck({ state: 'checking' });
    const t = setTimeout(async () => {
      try {
        const r = await api<{ available: boolean; reason?: string }>(`/api/seller/store/slug-check?slug=${encodeURIComponent(slug)}`);
        setCheck(r.available ? { state: 'ok' } : { state: 'bad', reason: r.reason ?? 'Not available' });
      } catch {
        setCheck({ state: 'idle' });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [slug]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/seller/store', { method: 'PUT', body: { slug } });
      await refresh();
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  const hint =
    check.state === 'checking' ? 'Checking…' : check.state === 'ok' ? '✓ Available' : check.state === 'bad' ? undefined : 'Lowercase letters, numbers and hyphens';

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {error && <Alert>{error}</Alert>}
      <Field label="Store address" error={check.state === 'bad' ? check.reason : undefined} hint={hint}>
        <div className="mt-1 flex items-center overflow-hidden rounded-xl border border-cream-300 bg-white focus-within:border-clay focus-within:ring-2 focus-within:ring-clay/20">
          <span className="select-none bg-cream-100 px-3 py-2.5 text-sm text-ink-faint">{window.location.host}/store/</span>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, '-'))}
            placeholder="riyas-creations"
            className="w-full bg-transparent px-2 py-2.5 text-sm outline-none"
            aria-label="Store address"
          />
        </div>
      </Field>
      <p className="text-sm text-ink-soft">This is the link you will share with customers. You can change it until you publish your store.</p>
      <Button type="submit" loading={busy} disabled={check.state !== 'ok'}>Create my store</Button>
    </form>
  );
}

export default function Onboarding() {
  const me = useMe();
  const { refresh } = useAuth();
  const step = me.onboarding.profileComplete ? 2 : 1;

  return (
    <div className="flex min-h-screen flex-col items-center px-5 py-10">
      <Logo to="/onboarding" />
      <div className="mt-8 w-full max-w-xl">
        <p className="text-sm font-medium text-clay">Step {step} of 2</p>
        <Card className="mt-2">
          {step === 1 ? (
            <>
              <h1 className="text-2xl font-semibold">Tell us about yourself</h1>
              <p className="mb-6 mt-1 text-sm text-ink-soft">So customers and GharSe know who is behind the brand.</p>
              <ProfileForm initial={me.profile} submitLabel="Continue" onSaved={refresh} />
            </>
          ) : (
            <>
              <h1 className="text-2xl font-semibold">Choose your store address</h1>
              <p className="mb-6 mt-1 text-sm text-ink-soft">Hi {me.profile?.fullName.split(' ')[0]}! Pick a short, memorable web address.</p>
              <StoreAddressStep />
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
