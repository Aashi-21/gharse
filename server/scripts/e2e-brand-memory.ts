/**
 * LIVE brand-memory acceptance test (real Claude, costs a few cents). Runs against TEST_DATABASE_URL (*_test).
 *
 *   npm run e2e:brand-memory -- /path/to/candle.jpg /path/to/crochet.jpg
 *
 * 1 register + onboard  2 create & approve a brand (real Claude)  3-4 candle photo -> draft listing
 * 5 log out  6 log in again  7-8 crochet photo -> second draft listing  9-10 compare with the saved brand.
 */
import fs from 'node:fs';
import { analyzeRequest, cookieFrom, makeApp, validProfile } from '../test/helpers';

const [candlePath, crochetPath] = process.argv.slice(2);
if (!candlePath || !crochetPath) {
  console.error('Usage: npm run e2e:brand-memory -- <candle-photo> <crochet-photo>');
  process.exit(2);
}
const j = (r: { body: string }) => JSON.parse(r.body);
const h = (s: string) => console.log(`\n=== ${s} ===`);

async function main() {
  const { app, config } = await makeApp();
  if (!app.ai.configured) throw new Error('ANTHROPIC_API_KEY is not set');
  console.log(`Model: ${config.CLAUDE_MODEL_SMART} | database: ${config.DATABASE_URL.split('@').pop()}`);

  const email = `maya.${Date.now()}@example.com`;
  const password = 'a-long-test-password-1';

  h('1. Register + onboarding');
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password } });
  const c1 = cookieFrom(reg);
  await app.inject({ method: 'PUT', url: '/api/seller/profile', headers: { cookie: c1 }, payload: validProfile });
  const slug = `maya-${Date.now().toString(36)}`;
  await app.inject({ method: 'PUT', url: '/api/seller/store', headers: { cookie: c1 }, payload: { slug } });
  console.log('registered', email, '| store', slug);

  h('2. Create + approve brand (real Claude)');
  const gen = await app.inject({
    method: 'POST', url: '/api/seller/brand/generate', headers: { cookie: c1 },
    payload: { productsMade: 'Candles and crochet home accessories', audience: 'Women who love cosy, colourful homes and thoughtful gifts', personality: 'Warm, cheerful, a little playful' },
  });
  if (gen.statusCode !== 200) throw new Error('brand generation failed: ' + gen.body);
  const { nameOptions: _n, ...brandFields } = j(gen).suggestion;
  const approved = await app.inject({ method: 'PUT', url: '/api/seller/brand', headers: { cookie: c1 }, payload: brandFields });
  const brand = j(approved).brand;
  console.log(`approved brand "${brand.name}" v${brand.version}\n  tagline: ${brand.tagline}\n  tone: ${brand.tone}\n  traits: ${brand.personalityTraits.join(', ')}\n  description style: ${brand.descriptionStyle}`);

  h('3-4. Candle photo -> draft listing (no seller notes: Claude must not invent facts)');
  const r1 = await analyzeRequest(app, c1, fs.readFileSync(candlePath));
  if (r1.statusCode !== 201) throw new Error(`candle analyze failed ${r1.statusCode}: ${r1.body}`);
  const p1 = j(r1).product;
  show(p1);

  h('5. Log out');
  console.log('logout status', (await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: c1 } })).statusCode);
  console.log('old session now rejected:', (await analyzeRequest(app, c1, fs.readFileSync(crochetPath))).statusCode === 401);

  h('6. Log in again (new session)');
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  const c2 = cookieFrom(login);
  console.log('login', login.statusCode, '| new session cookie differs:', c2 !== c1);

  h('7-8. Crochet photo -> second draft listing (brand read from PostgreSQL)');
  const r2 = await analyzeRequest(app, c2, fs.readFileSync(crochetPath));
  if (r2.statusCode !== 201) throw new Error(`crochet analyze failed ${r2.statusCode}: ${r2.body}`);
  const p2 = j(r2).product;
  show(p2);

  h('9-10. Verification');
  const row = await app.prisma.brandProfile.findFirstOrThrow({ where: { store: { slug } } });
  const gens = await app.prisma.aiGeneration.findMany({ where: { kind: 'LISTING', store: { slug } }, orderBy: { createdAt: 'asc' } });
  console.log(`brand row in PostgreSQL: "${row.name}" v${row.version} (${row.status})`);
  console.log(`product 1 brandVersion=${p1.brandVersion}, product 2 brandVersion=${p2.brandVersion}  -> same saved brand: ${p1.brandVersion === row.version && p2.brandVersion === row.version}`);
  console.log(`both products are DRAFT: ${p1.status === 'DRAFT' && p2.status === 'DRAFT'} | price null: ${p1.pricePaise === null && p2.pricePaise === null}`);
  console.log('Claude calls (listing):');
  for (const g of gens) console.log(`  ${g.status} model=${g.model} brandVersion=${g.brandVersion} in=${g.inputTokens} out=${g.outputTokens} ${g.latencyMs}ms productId=${g.productId ? 'linked' : 'none'}`);
  const brandAll = await app.prisma.aiGeneration.findMany({ where: { store: { slug } } });
  console.log(`total tokens this run: ${brandAll.reduce((n, g) => n + (g.inputTokens ?? 0), 0)} in + ${brandAll.reduce((n, g) => n + (g.outputTokens ?? 0), 0)} out across ${brandAll.length} call(s)`);
  await app.close();
}

function show(p: any) {
  console.log(`title: ${p.title}\ncategory: ${p.category}\ntags: ${p.tags.join(', ')}\ndescription: ${p.description}`);
  console.log('visible in photo:\n' + p.visibleCharacteristics.map((c: string) => '  - ' + c).join('\n'));
  console.log('questions for the seller:\n' + p.openQuestions.map((q: any) => `  - [${q.attribute}] ${q.question}`).join('\n'));
  console.log(`status=${p.status} price=${p.pricePaise} stock=${p.stock} brandVersion=${p.brandVersion}`);
}

main().then(() => process.exit(0), (e) => { console.error('FAILED:', e?.message ?? e); process.exit(1); });
