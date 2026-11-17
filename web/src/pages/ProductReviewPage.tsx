import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Field, Input, Select, Spinner, Textarea } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { PRODUCT_CATEGORIES, rupees } from '../lib/categories';
import type { Product } from '../lib/products';

export default function ProductReviewPage() {
  const { id } = useParams();
  const [product, setProduct] = useState<Product | null>(null);
  const [loadError, setLoadError] = useState('');
  const [f, setF] = useState({ title: '', description: '', category: '', tags: '', price: '', stock: '0' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});

  const load = (p: Product) => {
    setProduct(p);
    setF({ title: p.title, description: p.description, category: p.category ?? '', tags: p.tags.join(', '), price: rupees(p.pricePaise), stock: String(p.stock) });
  };

  useEffect(() => {
    api<{ product: Product }>(`/api/seller/products/${id}`)
      .then((r) => load(r.product))
      .catch((e) => setLoadError(e instanceof ApiError && e.status === 404 ? 'We could not find this product.' : 'Could not load this product.'));
  }, [id]);

  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => {
    setSaved(false);
    setF((p) => ({ ...p, [k]: e.target.value }));
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFields({});
    setSaved(false);
    try {
      const r = await api<{ product: Product }>(`/api/seller/products/${id}`, {
        method: 'PATCH',
        body: {
          title: f.title,
          description: f.description,
          category: f.category || null,
          tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
          price: f.price,
          stock: f.stock.trim() === '' ? 0 : Number(f.stock),
        },
      });
      load(r.product);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      if (err instanceof ApiError) setFields(err.fields);
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <Alert>{loadError} <Link to="/dashboard/products" className="font-medium underline">Back to products</Link></Alert>;
  if (!product) return <div className="flex justify-center py-20 text-clay"><Spinner className="h-7 w-7" /></div>;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/dashboard/products" className="text-sm text-ink-soft hover:underline">← All products</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold">Review your draft</h1>
          <span className="rounded-full bg-cream-200 px-3 py-1 text-xs font-medium text-ink-soft">Draft · not visible to customers</span>
        </div>
        <p className="mt-1 max-w-2xl text-ink-soft">
          Claude wrote this from your photo{product.brandVersion ? ` in your brand voice (brand version ${product.brandVersion})` : ''}. Check every line and change anything that is not right. Nothing is published automatically.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <aside className="space-y-4">
          {product.imageUrl && <img src={product.imageUrl} alt={product.title} className="w-full rounded-2xl border border-cream-300 object-cover shadow-card" />}
          {product.visibleCharacteristics.length > 0 && (
            <Card className="!p-4">
              <p className="text-sm font-medium">What Claude can see in the photo</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                {product.visibleCharacteristics.map((c) => <li key={c}>{c}</li>)}
              </ul>
            </Card>
          )}
          {product.openQuestions.length > 0 && (
            <Card className="!p-4">
              <p className="text-sm font-medium">Details Claude could not tell from the photo</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                {product.openQuestions.map((q) => <li key={q.attribute + q.question}>{q.question}</li>)}
              </ul>
              <p className="mt-3 text-xs text-ink-faint">Add the answers to the description yourself. Claude did not guess them.</p>
            </Card>
          )}
          {product.sellerNotes && (
            <Card className="!p-4">
              <p className="text-sm font-medium">Your notes</p>
              <p className="mt-1 text-sm text-ink-soft">{product.sellerNotes}</p>
            </Card>
          )}
        </aside>

        <form onSubmit={save} className="space-y-5" noValidate>
          <Card className="space-y-5">
            {error && <Alert>{error}</Alert>}
            {saved && !error && <Alert kind="success">Draft saved.</Alert>}
            <Field label="Title" error={fields.title}><Input value={f.title} onChange={set('title')} maxLength={120} /></Field>
            <Field label="Description" error={fields.description} hint="Make sure every statement is true for your product.">
              <Textarea rows={6} value={f.description} onChange={set('description')} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Category" error={fields.category}>
                <Select value={f.category} onChange={set('category')}>
                  <option value="">Choose a category</option>
                  {PRODUCT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </Select>
              </Field>
              <Field label="Tags" error={fields.tags} hint="Separate with commas">
                <Input value={f.tags} onChange={set('tags')} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Price (₹)" error={fields.price} hint="You decide the price. Claude never sets it.">
                <Input value={f.price} onChange={set('price')} inputMode="decimal" placeholder="e.g. 499" />
              </Field>
              <Field label="Stock available" error={fields.stock} hint="Number of items you can supply">
                <Input value={f.stock} onChange={set('stock')} inputMode="numeric" />
              </Field>
            </div>
          </Card>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" loading={busy}>Save draft</Button>
            <span className="text-xs text-ink-faint">Publishing comes in the next step. Price and stock will be required then.</span>
          </div>
        </form>
      </div>
    </div>
  );
}
