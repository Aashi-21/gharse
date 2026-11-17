import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, Field, Spinner, Textarea } from '../components/ui';
import { apiForm, ApiError } from '../lib/api';
import type { Product } from '../lib/products';
import { resizeForUpload } from '../lib/resizeImage';

export default function NewProductPage() {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [photo, setPhoto] = useState<{ blob: Blob; url: string; width: number; height: number } | null>(null);
  const [notes, setNotes] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needBrand, setNeedBrand] = useState(false);

  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);

  async function choose(file: File | undefined) {
    if (!file) return;
    setError('');
    setPreparing(true);
    try {
      const r = await resizeForUpload(file);
      setPhoto({ ...r, url: URL.createObjectURL(r.blob) });
    } catch (e) {
      setPhoto(null);
      setError(e instanceof Error ? e.message : 'Could not use that photo.');
    } finally {
      setPreparing(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!photo) return;
    setBusy(true);
    setError('');
    setNeedBrand(false);
    const form = new FormData();
    form.append('image', photo.blob, 'photo.jpg');
    if (notes.trim()) form.append('notes', notes.trim());
    try {
      const r = await apiForm<{ product: Product }>('/api/seller/products/analyze', form);
      navigate(`/dashboard/products/${r.product.id}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'brand_required') setNeedBrand(true);
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  if (busy) {
    return (
      <Card className="mx-auto flex max-w-xl flex-col items-center gap-4 py-14 text-center">
        <Spinner className="h-8 w-8 text-clay" />
        <div role="status">
          <p className="font-display text-xl font-semibold">Looking at your photo…</p>
          <p className="mt-1 text-sm text-ink-soft">Claude is drafting a listing in your brand voice. This usually takes 10 to 40 seconds.</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Add a product</h1>
        <p className="mt-1 text-ink-soft">One photo at a time. You will review and edit the draft before anything is saved as yours.</p>
      </div>

      <Card>
        <form onSubmit={submit} className="space-y-5" noValidate>
          {error && (
            <Alert>
              {error}
              {needBrand && <> <Link to="/dashboard/brand" className="font-medium underline">Go to your brand</Link></>}
            </Alert>
          )}

          <div>
            <p className="text-sm font-medium">Product photo</p>
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              aria-label="Choose a product photo"
              onChange={(e) => void choose(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => input.current?.click()}
              className="mt-2 flex w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-cream-300 bg-cream-50 px-4 py-6 text-center transition hover:border-clay"
            >
              {preparing ? (
                <span className="flex items-center gap-2 text-sm text-ink-soft"><Spinner /> Preparing photo…</span>
              ) : photo ? (
                <>
                  <img src={photo.url} alt="Selected product" className="max-h-72 rounded-xl object-contain" />
                  <span className="mt-3 text-sm text-ink-soft">Tap to choose a different photo</span>
                </>
              ) : (
                <>
                  <span className="text-sm font-medium">Choose or take a photo</span>
                  <span className="mt-1 text-xs text-ink-faint">JPEG, PNG or WebP. A clear, well-lit photo of the product works best.</span>
                </>
              )}
            </button>
          </div>

          <Field
            label="Anything we should know? (optional)"
            hint="Only facts you add here are used besides what is visible in the photo. For example the material, size, or whether it is scented."
          >
            <Textarea rows={3} value={notes} maxLength={600} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. soy wax candle, 200 g, lavender scent" />
          </Field>

          <Button type="submit" disabled={!photo || preparing}>Create draft listing with Claude</Button>
        </form>
      </Card>
    </div>
  );
}
