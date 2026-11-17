import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Field, Input, Select, Spinner, Textarea } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PRODUCT_CATEGORIES, rupees } from '../lib/categories';
import type { Product } from '../lib/products';

const toForm = (p: Product) => ({
  title: p.title,
  description: p.description,
  category: p.category ?? '',
  tags: p.tags.join(', '),
  price: rupees(p.pricePaise),
  stock: String(p.stock),
});
type Form = ReturnType<typeof toForm>;

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

export default function ProductReviewPage() {
  const { id } = useParams();
  const { refresh } = useAuth(); // keeps the dashboard checklist (product counts) in step
  const [product, setProduct] = useState<Product | null>(null);
  const [loadError, setLoadError] = useState('');
  const [f, setF] = useState<Form | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'publish' | 'unpublish' | 'regenerate' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [accurate, setAccurate] = useState(false);

  const load = (p: Product) => {
    setProduct(p);
    setF(toForm(p));
    setAnswers(Object.fromEntries(p.answers.map((a) => [a.attribute, a.answer])));
  };

  useEffect(() => {
    api<{ product: Product }>(`/api/seller/products/${id}`)
      .then((r) => load(r.product))
      .catch((e) => setLoadError(e instanceof ApiError && e.status === 404 ? 'We could not find this product.' : 'Could not load this product.'));
  }, [id]);

  if (loadError) return <Alert>{loadError} <Link to="/dashboard/products" className="font-medium underline">Back to products</Link></Alert>;
  if (!product || !f) return <div className="flex justify-center py-20 text-clay"><Spinner className="h-7 w-7" /></div>;

  const live = product.status === 'PUBLISHED';
  const dirty = JSON.stringify(f) !== JSON.stringify(toForm(product));
  const set = (k: keyof Form) => (e: { target: { value: string } }) => {
    setNotice('');
    setF((p) => (p ? { ...p, [k]: e.target.value } : p));
  };

  const reset = () => {
    setError('');
    setNotice('');
    setFields({});
  };
  const fail = (e: unknown) => {
    setError(errMsg(e));
    if (e instanceof ApiError) setFields(e.fields);
  };

  const body = () => ({
    title: f.title,
    description: f.description,
    category: f.category || null,
    tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
    price: f.price,
    stock: f.stock.trim() === '' ? 0 : Number(f.stock),
  });

  async function save(e?: FormEvent): Promise<boolean> {
    e?.preventDefault();
    reset();
    setBusy('save');
    try {
      const r = await api<{ product: Product }>(`/api/seller/products/${product!.id}`, { method: 'PATCH', body: body() });
      load(r.product);
      setNotice(live ? 'Changes saved.' : 'Draft saved.');
      return true;
    } catch (err) {
      fail(err);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    // Save any unsaved edits first so the backend validates exactly what the seller sees.
    if (dirty && !(await save())) return;
    reset();
    setBusy('publish');
    try {
      const r = await api<{ product: Product }>(`/api/seller/products/${product!.id}/publish`, { method: 'POST', body: { confirmAccuracy: true } });
      load(r.product);
      setAccurate(false);
      setNotice('Published. This product is now marked live.');
      await refresh();
    } catch (err) {
      fail(err);
      // refresh the checklist from the server so the seller sees what is still missing
      api<{ product: Product }>(`/api/seller/products/${product!.id}`).then((r) => setProduct(r.product)).catch(() => undefined);
    } finally {
      setBusy(null);
    }
  }

  async function unpublish() {
    reset();
    setConfirmUnpublish(false);
    setBusy('unpublish');
    try {
      const r = await api<{ product: Product }>(`/api/seller/products/${product!.id}/unpublish`, { method: 'POST' });
      load(r.product);
      setNotice('Unpublished. This product is a draft again and is no longer live.');
      await refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  async function regenerate() {
    reset();
    setConfirmRegen(false);
    setBusy('regenerate');
    try {
      const r = await api<{ product: Product }>(`/api/seller/products/${product!.id}/regenerate`, {
        method: 'POST',
        body: { answers: Object.entries(answers).map(([attribute, answer]) => ({ attribute, answer })) },
      });
      load(r.product);
      setNotice('New draft written from your photo and answers. Your price, stock and notes were kept. Please read it again.');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  }

  const answeredElsewhere = product.answers.filter((a) => !product.openQuestions.some((q) => q.attribute === a.attribute));
  const anyAnswer = Object.values(answers).some((a) => a.trim());

  return (
    <div className="space-y-6">
      <div>
        <Link to="/dashboard/products" className="text-sm text-ink-soft hover:underline">← All products</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-semibold">{live ? 'Your live product' : 'Review your draft'}</h1>
          {live ? (
            <span className="rounded-full bg-sage-light px-3 py-1 text-xs font-medium text-sage">
              Live{product.publishedAt ? ` since ${new Date(product.publishedAt).toLocaleDateString('en-IN')}` : ''}
            </span>
          ) : (
            <span className="rounded-full bg-cream-200 px-3 py-1 text-xs font-medium text-ink-soft">Draft · not visible to customers</span>
          )}
        </div>
        <p className="mt-1 max-w-2xl text-ink-soft">
          {live
            ? 'Edits are saved straight to the live listing, so it must always keep a title, description, category and price. Your public store page is a later step.'
            : `Claude wrote this from your photo${product.brandVersion ? ` in your brand voice (brand version ${product.brandVersion})` : ''}. Check every line. Nothing is published until you say so.`}
        </p>
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && !error && <Alert kind="success">{notice}</Alert>}

      <div className="grid gap-6 lg:grid-cols-[19rem_1fr]">
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

          {product.sellerNotes && (
            <Card className="!p-4">
              <p className="text-sm font-medium">Your notes</p>
              <p className="mt-1 text-sm text-ink-soft">{product.sellerNotes}</p>
            </Card>
          )}

          {busy === 'regenerate' ? (
            <Card className="flex flex-col items-center gap-3 !p-6 text-center">
              <Spinner className="h-6 w-6 text-clay" />
              <p role="status" className="text-sm text-ink-soft">Writing a new draft… this takes 10 to 40 seconds.</p>
            </Card>
          ) : live ? (
            product.answers.length > 0 && (
              <Card className="!p-4">
                <p className="text-sm font-medium">Your answers</p>
                <ul className="mt-2 space-y-2 text-sm text-ink-soft">
                  {product.answers.map((a) => <li key={a.attribute}><span className="text-ink-faint">{a.question}</span><br />{a.answer}</li>)}
                </ul>
                <p className="mt-3 text-xs text-ink-faint">Unpublish this product to answer questions and regenerate the listing.</p>
              </Card>
            )
          ) : (
            <Card className="!p-4">
              {product.openQuestions.length > 0 ? (
                <>
                  <p className="text-sm font-medium">Details Claude could not tell from the photo</p>
                  <p className="mt-1 text-xs text-ink-faint">Answer what you know. Anything you leave blank stays unknown. Claude will not guess.</p>
                  <div className="mt-3 space-y-3">
                    {product.openQuestions.map((q) => (
                      <label key={q.attribute} className="block text-sm">
                        <span className="text-ink-soft">{q.question}</span>
                        <Textarea
                          rows={2}
                          maxLength={300}
                          value={answers[q.attribute] ?? ''}
                          onChange={(e) => setAnswers((p) => ({ ...p, [q.attribute]: e.target.value }))}
                        />
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <p className="text-sm text-ink-soft">Claude has no open questions about this product.</p>
              )}
              {answeredElsewhere.length > 0 && (
                <div className="mt-4 border-t border-cream-200 pt-3">
                  <p className="text-sm font-medium">Answers you gave earlier</p>
                  <ul className="mt-2 space-y-2 text-sm text-ink-soft">
                    {answeredElsewhere.map((a) => <li key={a.attribute}><span className="text-ink-faint">{a.question}</span><br />{a.answer}</li>)}
                  </ul>
                </div>
              )}

              {!confirmRegen ? (
                <Button type="button" variant="secondary" className="mt-4 w-full" disabled={busy !== null} onClick={() => setConfirmRegen(true)}>
                  {anyAnswer ? 'Regenerate listing with my answers' : 'Regenerate listing'}
                </Button>
              ) : (
                <div className="mt-4 space-y-3 rounded-xl border border-clay/30 bg-clay-light p-3 text-sm text-clay-dark" role="alertdialog" aria-label="Confirm regeneration">
                  <p>
                    This <strong>replaces</strong> the title, description, category and tags with a new draft. Your price, stock, notes and answers are kept.
                    {dirty && <> You have unsaved edits, and they will be lost.</>}
                  </p>
                  <div className="flex gap-2">
                    <Button type="button" onClick={regenerate}>Yes, replace them</Button>
                    <Button type="button" variant="ghost" onClick={() => setConfirmRegen(false)}>Cancel</Button>
                  </div>
                </div>
              )}
            </Card>
          )}
        </aside>

        <form onSubmit={save} className="space-y-5" noValidate>
          <Card className="space-y-5">
            <Field label="Title" error={fields.title}><Input value={f.title} onChange={set('title')} maxLength={120} /></Field>
            <Field label="Description" error={fields.description} hint="Make sure every statement is true for your product. At least 20 characters to publish.">
              <Textarea rows={6} value={f.description} onChange={set('description')} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Category" error={fields.category}>
                <Select value={f.category} onChange={set('category')}>
                  <option value="">Choose a category</option>
                  {PRODUCT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </Select>
              </Field>
              <Field label="Tags (optional)" error={fields.tags} hint="Separate with commas">
                <Input value={f.tags} onChange={set('tags')} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Price (₹) *" error={fields.price} hint="You decide the price. Claude never sets it.">
                <Input value={f.price} onChange={set('price')} inputMode="decimal" placeholder="e.g. 499" />
              </Field>
              <Field label="Stock available *" error={fields.stock} hint={live ? 'Set to 0 if sold out.' : 'How many you can supply (at least 1 to publish).'}>
                <Input value={f.stock} onChange={set('stock')} inputMode="numeric" />
              </Field>
            </div>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant={live ? 'primary' : 'secondary'} loading={busy === 'save'} disabled={busy !== null && busy !== 'save'}>
              {live ? 'Save changes' : 'Save draft'}
            </Button>
            {dirty && <span className="text-xs text-ink-faint">You have unsaved changes.</span>}
          </div>

          {!live && (
            <Card className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Publish</h2>
                {product.readiness.issues.length > 0 ? (
                  <>
                    <p className="mt-1 text-sm text-ink-soft">Still needed (based on your last saved version):</p>
                    <ul className="mt-2 space-y-1 text-sm">
                      {product.readiness.issues.map((i) => (
                        <li key={i.field} className="flex items-start gap-2 text-clay-dark"><span aria-hidden>○</span>{i.message}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="mt-1 flex items-center gap-2 text-sm text-sage"><span aria-hidden>✓</span> Everything required is filled in.</p>
                )}
              </div>
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" checked={accurate} onChange={(e) => setAccurate(e.target.checked)} className="mt-1 h-4 w-4 accent-clay" />
                <span>I have read this listing and checked that everything in it is accurate and true for my product.</span>
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" loading={busy === 'publish'} disabled={!accurate || (busy !== null && busy !== 'publish')} onClick={publish}>
                  Publish product
                </Button>
                <span className="text-xs text-ink-faint">Unsaved edits are saved first. You can unpublish at any time.</span>
              </div>
            </Card>
          )}

          {live && (
            <Card className="space-y-3">
              <h2 className="text-lg font-semibold">Unpublish</h2>
              <p className="text-sm text-ink-soft">Takes this product off sale and turns it back into a draft. Nothing is deleted, and you can publish it again later.</p>
              {!confirmUnpublish ? (
                <Button type="button" variant="secondary" disabled={busy !== null} onClick={() => setConfirmUnpublish(true)}>Unpublish this product</Button>
              ) : (
                <div className="flex flex-wrap items-center gap-2 text-sm" role="alertdialog" aria-label="Confirm unpublish">
                  <span>Unpublish and return to draft?</span>
                  <Button type="button" loading={busy === 'unpublish'} onClick={unpublish}>Yes, unpublish</Button>
                  <Button type="button" variant="ghost" onClick={() => setConfirmUnpublish(false)}>Cancel</Button>
                </div>
              )}
            </Card>
          )}
        </form>
      </div>
    </div>
  );
}
