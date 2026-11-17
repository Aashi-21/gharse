import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Field, Input, Spinner, Textarea } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

interface BrandDraft {
  name: string;
  tagline: string;
  story: string;
  primaryColor: string;
  secondaryColor: string;
  tone: string;
  personalityTraits: string[];
  descriptionStyle: string;
  visualGuidelines: string;
}
interface SavedBrand extends BrandDraft {
  version: number;
  approvedAt: string | null;
}
interface Suggestion extends BrandDraft {
  nameOptions: string[];
}

const PERSONALITIES = ['Warm', 'Elegant', 'Playful', 'Rustic', 'Minimal', 'Festive', 'Luxurious', 'Earthy', 'Modern', 'Traditional'];

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

function BrandPreview({ b }: { b: BrandDraft }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-cream-300 bg-white shadow-card" aria-label="Brand preview">
      <div className="px-6 py-8" style={{ backgroundColor: b.primaryColor, color: '#fff' }}>
        <p className="font-display text-3xl font-semibold">{b.name || 'Your brand name'}</p>
        <p className="mt-1 text-sm opacity-90">{b.tagline || 'Your tagline'}</p>
        <div className="mt-4 h-1.5 w-16 rounded-full" style={{ backgroundColor: b.secondaryColor }} />
      </div>
      <div className="space-y-2 px-6 py-5">
        <p className="text-xs font-medium uppercase tracking-widest" style={{ color: b.primaryColor }}>Our story</p>
        <p className="text-sm leading-relaxed text-ink-soft">{b.story || 'Your story appears here.'}</p>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {b.personalityTraits.map((t) => (
            <span key={t} className="rounded-full px-2.5 py-0.5 text-xs" style={{ backgroundColor: b.secondaryColor + '55', color: '#2b211c' }}>{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ColorField({ label, value, onChange, error }: { label: string; value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <Field label={label} error={error}>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000'}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="h-10 w-12 cursor-pointer rounded-lg border border-cream-300 bg-white p-1"
        />
        <Input value={value} onChange={(e) => onChange(e.target.value)} className="!mt-0 font-mono" maxLength={7} />
      </div>
    </Field>
  );
}

function BriefStep({ onSuggestion, onCancel }: { onSuggestion: (s: Suggestion) => void; onCancel?: () => void }) {
  const [productsMade, setProductsMade] = useState('');
  const [audience, setAudience] = useState('');
  const [preferredName, setPreferredName] = useState('');
  const [chips, setChips] = useState<string[]>([]);
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});

  const toggle = (c: string) => setChips((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const personality = [...chips, extra.trim()].filter(Boolean).join(', ');
    setBusy(true);
    setError('');
    setFields({});
    try {
      const r = await api<{ suggestion: Suggestion }>('/api/seller/brand/generate', {
        method: 'POST',
        body: { productsMade, audience, preferredName, personality },
      });
      onSuggestion(r.suggestion);
    } catch (err) {
      setError(errMsg(err));
      if (err instanceof ApiError) setFields(err.fields);
      setBusy(false);
    }
  }

  if (busy) {
    return (
      <Card className="flex flex-col items-center gap-4 py-14 text-center" >
        <Spinner className="h-8 w-8 text-clay" />
        <div role="status">
          <p className="font-display text-xl font-semibold">Shaping your brand…</p>
          <p className="mt-1 text-sm text-ink-soft">This usually takes 10 to 30 seconds. Please keep this page open.</p>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <form onSubmit={submit} className="space-y-5" noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="What do you make?" error={fields.productsMade} hint="e.g. hand-poured soy candles, crochet bags, resin coasters">
          <Textarea rows={2} value={productsMade} onChange={(e) => setProductsMade(e.target.value)} />
        </Field>
        <Field label="Who are your customers?" error={fields.audience} hint="e.g. young professionals who love cosy homes, or gift buyers during festivals">
          <Textarea rows={2} value={audience} onChange={(e) => setAudience(e.target.value)} />
        </Field>
        <Field label="Do you already have a brand name? (optional)" error={fields.preferredName} hint="If yes, we will keep it exactly. If not, we will suggest a few.">
          <Input value={preferredName} onChange={(e) => setPreferredName(e.target.value)} maxLength={60} />
        </Field>
        <div>
          <p className="text-sm font-medium">How should your brand feel?</p>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Brand personality">
            {PERSONALITIES.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={chips.includes(c)}
                onClick={() => toggle(c)}
                className={`rounded-full border px-3.5 py-1.5 text-sm transition ${chips.includes(c) ? 'border-clay bg-clay-light text-clay-dark' : 'border-cream-300 bg-white text-ink-soft hover:bg-cream-200'}`}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="mt-3">
            <Field label="Anything else about the feeling? (optional)" error={fields.personality}>
              <Input value={extra} onChange={(e) => setExtra(e.target.value)} maxLength={120} placeholder="e.g. like a hug from home" />
            </Field>
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={!productsMade.trim() || !audience.trim() || (chips.length === 0 && !extra.trim())}>
            Create my brand with Claude
          </Button>
          {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
        </div>
      </form>
    </Card>
  );
}

function ReviewStep({
  initial, nameOptions, version, onSaved, onRegenerate, onDiscard,
}: {
  initial: BrandDraft;
  nameOptions: string[];
  version: number | null;
  onSaved: (b: SavedBrand) => void;
  onRegenerate: () => void;
  onDiscard?: () => void;
}) {
  const [b, setB] = useState<BrandDraft>(initial);
  const [traits, setTraits] = useState(initial.personalityTraits.join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const set = <K extends keyof BrandDraft>(k: K, v: BrandDraft[K]) => setB((p) => ({ ...p, [k]: v }));
  const parsedTraits = traits.split(',').map((t) => t.trim()).filter(Boolean);
  const live = { ...b, personalityTraits: parsedTraits };

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFields({});
    try {
      const r = await api<{ brand: SavedBrand }>('/api/seller/brand', { method: 'PUT', body: live });
      onSaved(r.brand);
    } catch (err) {
      setError(errMsg(err));
      if (err instanceof ApiError) setFields(err.fields);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <form onSubmit={save} className="space-y-5" noValidate>
        <Card className="space-y-5">
          {error && <Alert>{error}</Alert>}
          {nameOptions.length > 0 && (
            <div>
              <p className="text-sm font-medium">Name ideas — tap to choose</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {nameOptions.map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-pressed={b.name === n}
                    onClick={() => set('name', n)}
                    className={`rounded-full border px-3.5 py-1.5 text-sm ${b.name === n ? 'border-clay bg-clay-light text-clay-dark' : 'border-cream-300 bg-white hover:bg-cream-200'}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          )}
          <Field label="Brand name" error={fields.name}><Input value={b.name} onChange={(e) => set('name', e.target.value)} maxLength={60} /></Field>
          <Field label="Tagline" error={fields.tagline}><Input value={b.tagline} onChange={(e) => set('tagline', e.target.value)} maxLength={120} /></Field>
          <Field label="Brand story" error={fields.story} hint="Check that every line is true — you can change anything."><Textarea rows={5} value={b.story} onChange={(e) => set('story', e.target.value)} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <ColorField label="Primary colour" value={b.primaryColor} onChange={(v) => set('primaryColor', v)} error={fields.primaryColor} />
            <ColorField label="Secondary colour" value={b.secondaryColor} onChange={(v) => set('secondaryColor', v)} error={fields.secondaryColor} />
          </div>
          <Field label="Brand tone" error={fields.tone}><Input value={b.tone} onChange={(e) => set('tone', e.target.value)} maxLength={200} /></Field>
          <Field label="Personality traits" error={fields.personalityTraits} hint="Separate with commas"><Input value={traits} onChange={(e) => setTraits(e.target.value)} /></Field>
          <Field label="How product descriptions are written" error={fields.descriptionStyle} hint="Every future listing will follow this style.">
            <Textarea rows={3} value={b.descriptionStyle} onChange={(e) => set('descriptionStyle', e.target.value)} />
          </Field>
          <Field label="Visual guidelines" error={fields.visualGuidelines}><Textarea rows={3} value={b.visualGuidelines} onChange={(e) => set('visualGuidelines', e.target.value)} /></Field>
        </Card>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={busy}>{version ? 'Approve & save changes' : 'Approve & save brand'}</Button>
          <Button type="button" variant="secondary" onClick={onRegenerate}>Start over with Claude</Button>
          {onDiscard && <Button type="button" variant="ghost" onClick={onDiscard}>Discard changes</Button>}
        </div>
      </form>
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <BrandPreview b={live} />
      </aside>
    </div>
  );
}

export default function BrandPage() {
  const { refresh } = useAuth();
  const [stage, setStage] = useState<'loading' | 'brief' | 'review'>('loading');
  const [saved, setSaved] = useState<SavedBrand | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [notice, setNotice] = useState('');
  const [loadError, setLoadError] = useState('');
  const [rev, setRev] = useState(0); // remounts the review form when its source changes

  useEffect(() => {
    api<{ brand: SavedBrand | null }>('/api/seller/brand')
      .then((r) => {
        setSaved(r.brand);
        setStage(r.brand ? 'review' : 'brief');
      })
      .catch((e) => setLoadError(errMsg(e)));
  }, []);

  if (loadError) return <Alert>{loadError}</Alert>;
  if (stage === 'loading') return <div className="flex justify-center py-20 text-clay"><Spinner className="h-7 w-7" /></div>;

  const draft: BrandDraft | null = suggestion ?? saved;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-semibold">Your brand</h1>
        <p className="mt-1 max-w-2xl text-ink-soft">
          {stage === 'brief'
            ? 'Answer four quick questions and Claude will draft your brand. You review and edit everything before it is saved.'
            : saved && !suggestion
              ? `Approved · version ${saved.version}. GharSe uses this brand for every product you add.`
              : 'This is a draft. Nothing is saved until you approve it.'}
        </p>
      </div>
      {notice && <Alert kind="success">{notice}</Alert>}

      {stage === 'brief' && (
        <BriefStep
          onSuggestion={(s) => {
            setSuggestion(s);
            setNotice('');
            setRev((n) => n + 1);
            setStage('review');
          }}
          onCancel={saved ? () => setStage('review') : undefined}
        />
      )}

      {stage === 'review' && draft && (
        <ReviewStep
          key={rev}
          initial={draft}
          nameOptions={suggestion?.nameOptions ?? []}
          version={saved?.version ?? null}
          onRegenerate={() => setStage('brief')}
          onDiscard={suggestion && saved ? () => { setSuggestion(null); setRev((n) => n + 1); } : undefined}
          onSaved={async (b) => {
            setSaved(b);
            setSuggestion(null);
            setRev((n) => n + 1);
            setNotice(`Brand approved and saved (version ${b.version}).`);
            await refresh();
          }}
        />
      )}
    </div>
  );
}
