import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, Field, Input, Spinner, Textarea } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { rupees } from '../lib/categories';

interface StoreView {
  slug: string;
  isPublished: boolean;
  isSample: boolean;
  settings: { contactPhone: string | null; deliveryPolicy: string | null; returnPolicy: string | null; deliveryChargePaise: number };
  readiness: { canPublish: boolean; issues: { field: string; message: string }[] };
}

const toForm = (v: StoreView) => ({
  contactPhone: v.settings.contactPhone ?? '',
  deliveryCharge: rupees(v.settings.deliveryChargePaise) || '0',
  deliveryPolicy: v.settings.deliveryPolicy ?? '',
  returnPolicy: v.settings.returnPolicy ?? '',
});

export default function StorePage() {
  const { refresh } = useAuth();
  const [view, setView] = useState<StoreView | null>(null);
  const [f, setF] = useState<ReturnType<typeof toForm> | null>(null);
  const [busy, setBusy] = useState<'save' | 'publish' | 'unpublish' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState('');
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);

  const load = (v: StoreView) => {
    setView(v);
    setF(toForm(v));
  };
  useEffect(() => {
    api<StoreView>('/api/seller/store/settings').then(load).catch((e) => setLoadError(e instanceof ApiError ? e.message : 'Could not load your store settings.'));
  }, []);

  if (loadError) return <Alert>{loadError}</Alert>;
  if (!view || !f) return <div className="flex justify-center py-20 text-clay"><Spinner className="h-7 w-7" /></div>;

  const dirty = JSON.stringify(f) !== JSON.stringify(toForm(view));
  const url = `${window.location.origin}/store/${view.slug}`;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setNotice('');
    setF((p) => (p ? { ...p, [k]: e.target.value } : p));
  };
  const reset = () => {
    setError('');
    setNotice('');
    setFields({});
  };
  const fail = (e: unknown) => {
    setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    if (e instanceof ApiError) setFields(e.fields);
  };

  async function save(e?: FormEvent): Promise<boolean> {
    e?.preventDefault();
    reset();
    setBusy('save');
    try {
      load(await api<StoreView>('/api/seller/store/settings', { method: 'PUT', body: f }));
      setNotice('Store settings saved.');
      return true;
    } catch (err) {
      fail(err);
      return false;
    } finally {
      setBusy(null);
    }
  }
  async function action(kind: 'publish' | 'unpublish') {
    if (kind === 'publish' && dirty && !(await save())) return;
    reset();
    setConfirmUnpublish(false);
    setBusy(kind);
    try {
      load(await api<StoreView>(`/api/seller/store/${kind}`, { method: 'POST' }));
      setNotice(kind === 'publish' ? 'Your store is now public.' : 'Your store is offline. Customers can no longer see it.');
      await refresh();
    } catch (err) {
      fail(err);
      api<StoreView>('/api/seller/store/settings').then((v) => setView(v)).catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Your store</h1>
        <p className="mt-1 text-ink-soft">Set how customers reach you and what to expect, then make your store public. Publishing the store is separate from publishing each product.</p>
      </div>
      {error && <Alert>{error}</Alert>}
      {notice && !error && <Alert kind="success">{notice}</Alert>}

      <form onSubmit={save} className="space-y-5" noValidate>
        <Card className="space-y-5">
          <Field label="Contact phone shown to customers" error={fields.contactPhone} hint="Shown publicly on your store, only if you enter it here. It is never taken from your private profile.">
            <Input value={f.contactPhone} onChange={set('contactPhone')} inputMode="tel" placeholder="98765 43210" />
          </Field>
          <Field label="Delivery charge per order (₹)" error={fields.deliveryCharge} hint="One flat charge added to every order. Enter 0 for free delivery.">
            <Input value={f.deliveryCharge} onChange={set('deliveryCharge')} inputMode="decimal" />
          </Field>
          <Field label="Delivery policy" error={fields.deliveryPolicy} hint="For example how long you take to dispatch and where you deliver.">
            <Textarea rows={3} value={f.deliveryPolicy} onChange={set('deliveryPolicy')} maxLength={1000} />
          </Field>
          <Field label="Return policy" error={fields.returnPolicy}>
            <Textarea rows={3} value={f.returnPolicy} onChange={set('returnPolicy')} maxLength={1000} />
          </Field>
        </Card>
        <div className="flex items-center gap-3">
          <Button type="submit" loading={busy === 'save'} disabled={busy !== null && busy !== 'save'}>Save settings</Button>
          {dirty && <span className="text-xs text-ink-faint">You have unsaved changes.</span>}
        </div>
      </form>

      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">{view.isPublished ? 'Your store is public' : 'Make your store public'}</h2>
        {view.isPublished ? (
          <>
            <p className="text-sm text-ink-soft">Customers can open your store at:</p>
            <p className="break-all rounded-xl bg-cream-100 px-3 py-2 text-sm font-medium">
              <a href={url} target="_blank" rel="noreferrer" className="text-clay-dark hover:underline">{url}</a>
            </p>
            <p className="text-xs text-ink-faint">Only your published products are shown. Your store address cannot change while it is public.</p>
            {!confirmUnpublish ? (
              <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => setConfirmUnpublish(true)}>Take store offline</Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-sm" role="alertdialog" aria-label="Confirm unpublish store">
                <span>Customers will no longer be able to see or order from your store.</span>
                <Button type="button" loading={busy === 'unpublish'} onClick={() => action('unpublish')}>Yes, take it offline</Button>
                <Button type="button" variant="ghost" onClick={() => setConfirmUnpublish(false)}>Cancel</Button>
              </div>
            )}
          </>
        ) : (
          <>
            {view.readiness.issues.length > 0 ? (
              <>
                <p className="text-sm text-ink-soft">Still needed (based on your last saved settings):</p>
                <ul className="space-y-1 text-sm">
                  {view.readiness.issues.map((i) => (
                    <li key={i.field} className="flex items-start gap-2 text-clay-dark">
                      <span aria-hidden>○</span>
                      {i.message}
                      {i.field === 'products' && <> <Link to="/dashboard/products" className="underline">Open products</Link></>}
                      {i.field === 'brand' && <> <Link to="/dashboard/brand" className="underline">Open brand</Link></>}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="flex items-center gap-2 text-sm text-sage"><span aria-hidden>✓</span> Everything required is in place.</p>
            )}
            <Button type="button" loading={busy === 'publish'} disabled={busy !== null && busy !== 'publish'} onClick={() => action('publish')}>Make my store public</Button>
          </>
        )}
      </Card>
    </div>
  );
}
