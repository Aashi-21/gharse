/**
 * LIVE regeneration acceptance test (real Claude, a few cents). Runs against TEST_DATABASE_URL (*_test).
 *   npm run e2e:regenerate -- /path/to/photo.jpg
 * Flow: draft from photo (no seller notes) -> seller sets price/stock -> answers SOME of Claude's questions ->
 * regenerate -> check facts used / not invented, price+stock preserved -> publish (confirm required) -> unpublish.
 */
import fs from 'node:fs';
import { describeClaims } from '../src/modules/ai/claimGuard';
import { analyzeRequest, approveBrand, cookieFrom, makeApp, validProfile } from '../test/helpers';

const photoPath = process.argv[2];
if (!photoPath) {
  console.error('Usage: npm run e2e:regenerate -- <photo.jpg>');
  process.exit(2);
}
const j = (r: { body: string }) => JSON.parse(r.body);
const h = (s: string) => console.log(`\n=== ${s} ===`);
type Product = { id: string; title: string; description: string; category: string; tags: string[]; pricePaise: number | null; stock: number; status: string; sellerNotes: string; answers: { attribute: string; question: string; answer: string }[]; openQuestions: { attribute: string; question: string }[]; visibleCharacteristics: string[]; brandVersion: number; publishedAt: string | null; readiness: { canPublish: boolean; issues: { field: string }[] } };

function show(p: Product) {
  console.log(`title: ${p.title}\ncategory: ${p.category} | tags: ${p.tags.join(', ')}\ndescription: ${p.description}`);
  console.log('questions still open:\n' + (p.openQuestions.map((q) => `  - [${q.attribute}] ${q.question}`).join('\n') || '  (none)'));
  console.log(`status=${p.status} price=${p.pricePaise} stock=${p.stock} brandVersion=${p.brandVersion}`);
}

async function main() {
  const { app, config } = await makeApp();
  if (!app.ai.configured) throw new Error('ANTHROPIC_API_KEY is not set');
  console.log(`Model: ${config.CLAUDE_MODEL_SMART} | database: ${config.DATABASE_URL.split('@').pop()}`);

  const email = `regen.${Date.now()}@example.com`;
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password: 'a-long-test-password-1' } });
  const cookie = cookieFrom(reg);
  await app.inject({ method: 'PUT', url: '/api/seller/profile', headers: { cookie }, payload: validProfile });
  const slug = `regen-${Date.now().toString(36)}`;
  await app.inject({ method: 'PUT', url: '/api/seller/store', headers: { cookie }, payload: { slug } });
  const brand = await approveBrand(app, cookie, { name: 'Wick & Loop', tagline: 'Cosy things for colourful homes', tone: 'Warm, cheerful and a little playful', personalityTraits: ['warm', 'cheerful', 'playful'], descriptionStyle: 'Short, friendly sentences that speak directly to the customer as you. Highlight colour and cosiness. Avoid big unproven claims.' });
  console.log(`approved brand "${brand.name}" v${brand.version}`);

  h('1. Draft from the photo (real Claude, NO seller notes)');
  const created = await analyzeRequest(app, cookie, fs.readFileSync(photoPath));
  if (created.statusCode !== 201) throw new Error(`analyze failed ${created.statusCode}: ${created.body}`);
  const first: Product = j(created).product;
  show(first);

  h('2. Seller enters price and stock (the only way these ever get set)');
  const edited = await app.inject({ method: 'PATCH', url: `/api/seller/products/${first.id}`, headers: { cookie }, payload: { price: '₹ 899', stock: 3 } });
  console.log(`PATCH ${edited.statusCode} -> price paise ${j(edited).product.pricePaise}, stock ${j(edited).product.stock}`);

  h('3. Seller answers SOME questions with real facts (others left unanswered on purpose)');
  const facts: [RegExp, string][] = [
    [/material|yarn|fib/i, 'Cotton yarn.'],
    [/size|dimension|height|width|measure/i, 'About 20 cm tall and 25 cm wide.'],
    [/bear|include|prop/i, 'The teal bear is NOT included. It is only a prop in the photo.'],
    [/how_made|made|craft/i, 'Crocheted by hand by me.'],
  ];
  const answers = first.openQuestions.flatMap((q) => {
    const hit = facts.find(([re]) => re.test(q.attribute + ' ' + q.question));
    return hit ? [{ attribute: q.attribute, answer: hit[1] }] : [];
  });
  const unanswered = first.openQuestions.filter((q) => !answers.some((a) => a.attribute === q.attribute));
  console.log('answering:\n' + answers.map((a) => `  [${a.attribute}] ${a.answer}`).join('\n'));
  console.log('NOT answering:\n' + (unanswered.map((q) => `  [${q.attribute}] ${q.question}`).join('\n') || '  (none)'));

  h('4. Regenerate (real Claude)');
  const regen = await app.inject({ method: 'POST', url: `/api/seller/products/${first.id}/regenerate`, headers: { cookie }, payload: { answers } });
  if (regen.statusCode !== 200) throw new Error(`regenerate failed ${regen.statusCode}: ${regen.body}`);
  const next: Product = j(regen).product;
  show(next);

  h('5. Checks');
  const text = [next.title, next.description, ...next.tags, ...next.visibleCharacteristics];
  const supported = [first.sellerNotes, ...answers.map((a) => a.answer)].join('\n');
  const stray = describeClaims(text, supported);
  console.log(`preserved: price=${next.pricePaise === 89900} stock=${next.stock === 3} status=${next.status} notes="${next.sellerNotes}" answers saved=${next.answers.length}/${answers.length}`);
  console.log(`unsupported claims left in the text (guard re-check): ${stray.length === 0 ? 'none' : JSON.stringify(stray)}`);
  const mentions = (re: RegExp) => re.test([next.title, next.description].join(' '));
  console.log(`uses seller facts -> cotton: ${mentions(/cotton/i)} | 20 cm / 25 cm: ${mentions(/20\s?cm|25\s?cm/i)} | crocheted/hand: ${mentions(/crochet|hand/i)}`);
  console.log(`invented anyway? care/washing: ${mentions(/wash|machine|care|dry clean/i)} | eco/natural: ${mentions(/eco|natural|sustainab/i)} | claims bear included: ${mentions(/(comes|includes|included).{0,20}bear|bear.{0,20}(included|comes)/i)}`);
  console.log(`answered questions no longer re-asked: ${answers.every((a) => !next.openQuestions.some((q) => q.attribute === a.attribute))}`);

  h('6. Publish: confirmation is enforced by the API');
  const base = `/api/seller/products/${first.id}`;
  const noConfirm = await app.inject({ method: 'POST', url: `${base}/publish`, headers: { cookie }, payload: {} });
  console.log(`publish without confirmAccuracy -> ${noConfirm.statusCode} (${j(noConfirm).error.code})`);
  const pub = await app.inject({ method: 'POST', url: `${base}/publish`, headers: { cookie }, payload: { confirmAccuracy: true } });
  const published: Product = j(pub).product;
  const store = await app.prisma.store.findFirstOrThrow({ where: { slug } });
  console.log(`publish with confirmation -> ${pub.statusCode}, status=${published.status}, publishedAt set=${!!published.publishedAt}, Store.isPublished still=${store.isPublished}`);
  const blocked = await app.inject({ method: 'POST', url: `${base}/regenerate`, headers: { cookie }, payload: {} });
  console.log(`regenerate while live -> ${blocked.statusCode} (${j(blocked).error.code})`);
  const un = await app.inject({ method: 'POST', url: `${base}/unpublish`, headers: { cookie } });
  console.log(`unpublish -> ${un.statusCode}, status=${j(un).product.status}, price kept=${j(un).product.pricePaise === 89900}`);

  h('7. Usage');
  const rows = await app.prisma.aiGeneration.findMany({ where: { store: { slug } }, orderBy: { createdAt: 'asc' } });
  for (const r of rows) console.log(`  ${r.kind} ${r.status} model=${r.model} brandVersion=${r.brandVersion} in=${r.inputTokens} out=${r.outputTokens} ${r.latencyMs}ms productId=${r.productId ? 'linked' : 'none'}`);
  console.log(`total: ${rows.reduce((n, r) => n + (r.inputTokens ?? 0), 0)} in + ${rows.reduce((n, r) => n + (r.outputTokens ?? 0), 0)} out across ${rows.length} call(s)`);
  await app.close();
}

main().then(() => process.exit(0), (e) => { console.error('FAILED:', e?.message ?? e); process.exit(1); });
