# GharSe: Project Handoff

> Written 17 November 2026 from an inspection of the repository at **commit `d9b1b04`, branch `main`, working tree clean** (before this file was added). **Updated later the same day:** the contact form was implemented on top of `d9b1b04` (uncommitted; see §3 "Contact form" and §8).

> Every statement below was checked against the code or labelled as **assumption / not verified**. No secrets are recorded here; `.env` was never read.

---

## 1. Project overview

**GharSe** is an AI-assisted platform that helps women turn handmade products (candles, crochet, diyas, resin art, décor) into independent online businesses. It is a hackathon submission (GoDaddy Inclusive Innovation Hackathon 2026), not a marketplace: each seller gets their own branded store link.

- **Target users:** women home-based makers in India (INR, Indian phone/PIN/state validation); customers reached via WhatsApp/Instagram who order without an account.

- **Core differentiator: persistent approved brand memory.** A seller creates and approves a brand once; it is stored in PostgreSQL (`brand_profiles`, versioned). Every later AI listing and the public storefront read that saved row fresh from the database. No conversation history is ever used.

- **Demo journey (all implemented in code):**

  1. Seller registers, logs in, completes profile and picks a store address.

  2. Creates a brand with Claude, edits and approves it (saved to PostgreSQL).

  3. Uploads a product photo; Claude drafts a title/description/category/tags in the brand voice, never inventing facts; seller answers open questions, regenerates, edits, sets price and stock.

  4. Publishes the product (explicit accuracy confirmation).

  5. Sets contact phone, delivery charge, delivery and return policies; publishes the store.

  6. Customer opens `/store/<slug>`, opens a product, places a single-product order (no account, no payment).

  7. Seller sees the order in the dashboard and moves it through confirm / ship / deliver / cancel.

- **Product decisions already approved by the owner:** single-product checkout (no cart); no online payment (payment is arranged directly between customer and seller, COD wording); stock reserved at order creation and restored on cancel; the seeded sample store is public as a "Demo store" with checkout blocked; confirmation page only (no public order tracking); idempotency keys required; dashboard new-order badge only (no email notifications).

## 2. Tech stack and architecture

**Confirmed from code:** modular monolith, one Node process serves API and the built SPA.

| Layer | Implementation |

|---|---|

| Frontend | React 19, TypeScript, Vite 6, Tailwind 3, react-router-dom 7 (`web/`). Builds to `server/public`. Fonts bundled (`@fontsource-variable`). |

| Backend | Node (engines `>=20.17`, `.nvmrc` 20), TypeScript compiled to **CommonJS** (`server/dist`), Fastify 5 (`server/`). Plugins: helmet, cookie, rate-limit, multipart. |

| Database / ORM | PostgreSQL + Prisma 6 (`server/prisma/schema.prisma`, 4 migrations). `binaryTargets`: native, debian-openssl-3.0.x, rhel-openssl-3.0.x, rhel-openssl-1.0.x. |

| Validation | zod 4 on every route; env validated at startup (`server/src/config.ts`). |

| AI | Anthropic SDK (`@anthropic-ai/sdk`), backend only. **Sonnet 5.5 (`claude-sonnet-5-5`)** for brand generation and product listings (image + text), structured JSON output via `output_config.format` + zod re-validation (forced `tool_choice` is not used: it 400s on this model), effort `medium`. `CLAUDE_MODEL_FAST` (Haiku) is configured but **not used anywhere** in code. |

| Images | Browser resizes to ≤1568px JPEG; server validates by magic bytes; stored via a `Storage` interface with **only a local-disk driver** (`STORAGE_DRIVER` accepts only `local`). Never stored in PostgreSQL. |

| Auth | Server-side sessions: random 256-bit token in an httpOnly, SameSite=Lax cookie `gharse_sid` (Secure when `APP_URL` is https); only the SHA-256 is stored (`sessions`). Passwords hashed with scrypt (`node:crypto`). No password reset, no email verification (not implemented). |

| CSRF/origin | No CORS plugin (same-origin SPA). An `onRequest` hook rejects state-changing requests whose `Origin` is neither `APP_URL`'s origin nor the request `Host` (403 `bad_origin`). |

| Email | GoDaddy Node.js Hosting local email gateway, called through server/src/lib/emailGateway.ts and server/src/lib/mailer.ts. Used by the public contact form (POST /api/contact). Recipient is configured with CONTACT_TO; no SMTP credentials or external email provider are used. Health reports configuration only; actual delivery must be tested through the contact form. |

**Boundaries:** `server/src/modules/{auth,seller,brand,products,storefront,public,orders,ai,health}`, shared `lib/` and `plugins/`. AI access goes only through the `AiClient` interface (`modules/ai/client.ts`); tests inject a fake or point the real client at a local fake HTTP server (`ANTHROPIC_BASE_URL`).

## 3. Completed milestones (all committed; latest commit `d9b1b04`)

Commit history: `2aeca02` foundation + brand, `7c2ed41` product listing, `8e6eb99` publishing/regeneration, `d9b1b04` storefront/orders.

### Day 1: foundation

Scaffold, env validation, Prisma schema (all tables), seed, `/api/health`, registration/login/logout/me, seller profile, store address (slug), React onboarding + dashboard shell.

### Phase 1: brand creation and memory

- `GET /api/seller/brand`, `POST /api/seller/brand/generate` (suggestion only, nothing saved), `PUT /api/seller/brand` (approve & save; `version` increments, status `APPROVED`).

- One `brand_profiles` row per store, versioned in place. Quota: per-store hourly/daily caps counted from `ai_generations`.

### Phase 2: AI product creation

- `POST /api/seller/products/analyze` (multipart image + optional notes) → DRAFT product; requires an approved brand (409 `brand_required`); image validated before any AI spend; image written to storage only after Claude succeeds.

- `GET /api/seller/products`, `GET /:id`, `PATCH /:id`, `GET /:id/image` (seller-only).

- **Claim guard** (`modules/ai/claimGuard.ts`): regex backstop that rejects invented materials, sizes, scent, handmade/eco/quality claims, price/stock, inclusion/props, spiritual/health claims unless the seller's own notes/answers state them; one corrective retry, then 502 and nothing saved.

- Image rules: JPEG/PNG/WebP by magic bytes, 32-8000 px, ≤5 MiB (`IMAGE_LIMITS` in `lib/imageInfo.ts`, single constant; defensive length re-check in `upload.ts`); browser guard rejects originals >30 MiB.

### Phase 3, milestone 1: publishing and regeneration

- `POST /api/seller/products/:id/publish` (body `{confirmAccuracy:true}` required), `/unpublish`, `/regenerate` (drafts only; seller answers to Claude's questions; overwrites only AI-owned fields; any failure leaves the product unchanged).

- Publish rules (`modules/products/publishing.ts`): title ≥2, description ≥20 chars, category, price >0, stock ≥1, and a photo whose **file exists in storage with exactly the recorded size** (checked by `Storage.stat` before the transaction). Live products can be edited only if they stay publishable (stock may drop to 0).

- Row-locked transactions (`SELECT … FOR UPDATE`) for publish/unpublish/PATCH/regenerate.

- `modules/products/visibility.ts`: `PUBLIC_PRODUCT_FILTER = { status: 'PUBLISHED' }`, the only status filter public queries use.

### Phase 3, milestone 2: store, storefront, checkout, orders

- **Store settings/publish** (`modules/storefront/settings.ts`): `GET/PUT /api/seller/store/settings` (contactPhone, deliveryPolicy, returnPolicy, flat `deliveryCharge`), `POST /api/seller/store/publish|unpublish`. Store publish requires approved brand + explicit contact phone + both policies (≥10 chars) + ≥1 published product. **Independent of product publishing.** Contact phone is never copied from the private profile.

- **Public read API** (`modules/public/`): `GET /api/public/stores/:slug`, `…/products/:productSlug`, `…/products/:productSlug/image`. Whitelisted DTO (no ids, seller data, exact stock), `Cache-Control: no-store` (image: `public, max-age=300`). Unpublished store / no approved brand / draft or archived product / missing image file / malformed slug → the same generic 404.

- **Checkout** (`modules/orders/checkout.ts`, `publicRoutes.ts`): `POST /api/public/stores/:slug/orders`, header `Idempotency-Key` (8-64 chars `A-Za-z0-9_-`) required; body `{productSlug, quantity(1-10), customer{name,phone}, address{line1,line2?,city,state,pincode}, note?, website(honeypot)}`; strict schema rejects any client price/total/status. Demo (`isSample`) stores → 403 `demo_store`.

- **Seller orders** (`modules/orders/sellerRoutes.ts`, `transitions.ts`): `GET /api/seller/orders` (status filter, cursor pagination, per-status counts), `GET /api/seller/orders/:id`, `PATCH /api/seller/orders/:id/status`. `/api/auth/me` returns `counts{products,published}` and top-level `newOrders`.

- **Frontend routes** (`web/src/App.tsx`): `/`, `/login`, `/register`, `/onboarding`, `/dashboard` (index, `brand`, `products`, `products/new`, `products/:id`, `orders`, `orders/:id`, `store`, `profile`), public `/store/:slug`, `/store/:slug/p/:productSlug`.

### Contact form (added after `d9b1b04`, uncommitted)

- POST /api/contact (server/src/modules/contact/routes.ts) sends a plain-text message to CONTACT_TO through GoDaddy Node.js Hosting's local email gateway (server/src/lib/emailGateway.ts); the visitor's email is set as Reply-To. GoDaddy selects the sender address. Public page /contact (web/src/pages/ContactPage.tsx), linked from the landing page, store footers, login/register pages and the dashboard nav.

- Strict zod schema (`name` 2-80, `email`, `subject` 3-120 without line breaks, `message` 10-2000, honeypot `website`); control characters refused (header-injection protection); 16 KB body cap; per-IP limit `CONTACT_RATE_LIMIT_MAX` (default 10/hour, invalid requests count) plus an in-memory process-wide cap `CONTACT_HOURLY_LIMIT` (60/hour); `CONTACT_SEND_TIMEOUT_MS` (15000).

- Outcomes: 200 {sent:true} only after the GoDaddy gateway accepts the message; 400/413/429; 502 contact_failed (delivery error or timeout); 503 contact_unavailable when CONTACT_TO is not configured. Visitor name/email/message are never logged (errorLogPayload treats /api/contact as sensitive).

- Tests cover gateway success, gateway rejection, validation, rate limits and privacy. The old fake SMTP sink and Nodemailer dependency have been removed. Actual Preview delivery is still pending and must be verified by submitting the Preview contact form and checking the Titan mailbox.

### Models (`schema.prisma`)

`User`, `Session`, `SellerProfile`, `Store`, `BrandProfile`, `Product`, `ProductImage`, `Order`, `OrderItem`, `AiGeneration`. Enums: `BrandStatus`, `ProductStatus`, `OrderStatus`, `AiKind` (`IMAGE_ANALYSIS` and `MARKETING` exist but are unused), `AiStatus`. Money is integer paise.

## 4. Security and business rules (enforced in code, covered by tests)

- **Ownership/isolation:** every seller query starts from `getSellerStore(userId)`; foreign product/order ids are 404. Orders are scoped by `storeId`.

- **Customer PII** (name, phone, address, note) is stored on `orders` and returned **only** by `/api/seller/orders*` to the owning seller (`toSellerOrder`; internals `idempotencyKey`/`requestHash`/`storeId` excluded). Public APIs, checkout responses (including replays) and logs contain none: checkout error logging records only error class and code (`errorLogPayload` in `plugins/errors.ts`).

- **Public visibility:** only PUBLISHED products of a PUBLISHED store with an APPROVED brand. Slugs validated (`^[a-z0-9]+(-[a-z0-9]+)*$`) before any query (a `%00` in a URL once caused a 500; fixed and tested).

- **Idempotency:** unique `(storeId, idempotencyKey)` plus `requestHash` (same key + different request → 409 `idempotency_conflict`); per-key `pg_advisory_xact_lock` serialises concurrent identical requests; a retry after sell-out returns the original order (200, `replayed:true`).

- **Atomic stock:** one conditional `UPDATE products SET stock = stock - $q … AND stock >= $q RETURNING` in the order transaction; DB CHECK `stock >= 0`; order number from an atomic `UPDATE stores … RETURNING`. Stock restored exactly once on cancel (row-locked order).

- **Totals:** subtotal/delivery/total computed server-side from DB values; overflow beyond Postgres INT returns 400 and rolls back.

- **Order transitions:** NEW→CONFIRMED|CANCELLED; CONFIRMED→SHIPPED|CANCELLED; SHIPPED→DELIVERED; DELIVERED/CANCELLED final; same-status repeat is a no-op (409 `invalid_transition` otherwise); tracking note only when shipping.

- **Payment wording:** GharSe collects no payment; there is no "paid" field. Shown on checkout form, confirmation, and seller order view.

- **Rate limits:** global 300/min/IP; auth routes `AUTH_RATE_LIMIT_MAX` (10/min); checkout `ORDER_RATE_LIMIT_MAX` (10/min/IP), `ORDER_PHONE_HOURLY_LIMIT` (3/phone/store/hour), `ORDER_STORE_HOURLY_LIMIT` (100/store/hour); AI `AI_HOURLY_LIMIT` (20) / `AI_DAILY_LIMIT` (100) per store.

- **TRUST_PROXY:** default `false`; forwarded IP headers are ignored unless `TRUST_PROXY=true`. Tested both ways. Correct value depends on the unconfirmed hosting.

- **Headers:** helmet CSP (`default-src 'self'`, `img-src 'self' data: blob:`), HSTS only when `APP_URL` is https.

- **DB CHECK constraints:** published products need price>0, title ≥2 chars, `publishedAt`; `stock>=0`; `order_items.quantity>0`, `unitPricePaise>0`; `orders` amounts ≥0 and `totalPaise = subtotalPaise + deliveryPaise`.

## 5. Database

**Migrations, in order** (`server/prisma/migrations/`):

1. `20261117043255_init`: all tables.

2. `20261117052412_product_ai_draft_fields`: `products.brandVersion`, `visibleCharacteristics`, `aiDraft`.

3. `20261117095640_product_publishing`: `products.publishedAt`, backfill, 4 CHECK constraints (raw SQL).

4. `20261117190000_order_idempotency`: `orders.idempotencyKey` + `requestHash` (NOT NULL; orders table was empty), unique index, 4 CHECK constraints. Created by hand from `prisma migrate diff` output (Prisma refused to generate it non-interactively); `migrate diff` reports no drift.

**Apply (documented in README/package scripts; not run against any production DB):**

- Development: `npm run db:migrate` (`prisma migrate dev`).

- Test DB (name must end `_test`; tests TRUNCATE): `DATABASE_URL=$TEST_DATABASE_URL npm run db:deploy`.

- Production: set `DATABASE_URL`, then `npm run db:deploy` (`prisma migrate deploy`; `prisma` is a runtime dependency of `server`).

- Seed: `npm run db:seed` creates ONE clearly-labelled sample seller/store/brand/3 products (`sample.seller@gharse.example`, store `sample-meeras-diyas`, `isSample=true`, **no public contact phone**, products have no photos). Idempotent; password from `SEED_SAMPLE_PASSWORD` or random (printed). Refuses in production unless `ALLOW_SEED=true` (read from `process.env`, not listed in `.env.example`).

## 6. Environment configuration (names from `.env.example`; values deliberately omitted)

| Variable | Purpose | Production |

|---|---|---|

| `NODE_ENV` | `development`/`test`/`production` (guards seed, affects logging) | **Required: `production`** |

| `PORT` | Listen port | Hosting-dependent (Passenger/Docker assign it); default 3000 |

| `HOST` | Bind address | Default `0.0.0.0` |

| `APP_URL` | Exact public origin; drives cookie `Secure`, HSTS and the origin check | **Required** (`https://<domain>`). A wrong value makes every POST 403 |

| `TRUST_PROXY` | Trust `X-Forwarded-For` | Hosting-dependent; default `false` |

| `DATABASE_URL` | PostgreSQL connection string | **Required**; hosting-dependent |

| `TEST_DATABASE_URL` | Test DB (must end `_test`) | Dev/test only |

| `SESSION_TTL_DAYS` | Session lifetime (default 14) | Optional |

| `AUTH_RATE_LIMIT_MAX` | Auth requests/min/IP (default 10) | Optional |

| `ORDER_RATE_LIMIT_MAX`, `ORDER_PHONE_HOURLY_LIMIT`, `ORDER_STORE_HOURLY_LIMIT` | Checkout limits (10 / 3 / 100) | Optional |

| `STORAGE_DRIVER` | Only `local` exists | Optional |

| `UPLOAD_DIR` | Image directory (default `uploads`, resolved from repo root) | **Must point at persistent disk**; hosting-dependent |

| CONTACT_TO | Recipient mailbox for the contact form. Email is sent through GoDaddy Node.js Hosting's local gateway at 127.0.0.1:2525; GoDaddy selects the sender. No SMTP host, port, username, password or MAIL_FROM setting is used. | Required for contact form delivery; verify actual delivery in Preview. |

| `CONTACT_RATE_LIMIT_MAX`, `CONTACT_HOURLY_LIMIT`, `CONTACT_SEND_TIMEOUT_MS` | Contact form limits per IP per hour (10) and overall per hour (60), and mail send timeout (15000 ms) | Optional |

| `ANTHROPIC_API_KEY` | Claude API key (secret) | **Required for AI features** |

| `CLAUDE_MODEL_SMART` | Default `claude-sonnet-5-5` | Optional |

| `CLAUDE_MODEL_FAST` | Default `claude-haiku-5-5` (unused) | Optional |

| `AI_TIMEOUT_MS`, `AI_MAX_RETRIES`, `AI_HOURLY_LIMIT`, `AI_DAILY_LIMIT` | AI call tuning and per-store caps (90000 / 2 / 20 / 100) | Optional |

| `SEED_SAMPLE_PASSWORD` | Demo seed password | Dev/demo only |

Real environment variables override the repo-root `.env` (loaded via `process.loadEnvFile`, which needs **Node ≥ 20.12**; `engines` says ≥20.17).

## 7. Development and verification

Commands come from the package scripts. **Verified = actually executed in the working session that built this project.**

| Command | Status |

|---|---|

| `npm install` | Verified |

| npm test (serial; latest run on 19 Nov 2026: 353 tests passed, 0 failed, 72 suites) | Verified locally on 19 Nov 2026 |

| `npm run typecheck` (server + web) | Verified |

| `npm run build` (web → `server/public`, prisma generate, `tsc` → `server/dist`) | Verified |

| `npm start` (`node server/dist/server.js`, Node 20.17, local) and real-HTTP smoke tests against it (curl, parallel checkout, health) | Verified locally only |

| `npm run db:migrate`, `npm run db:deploy` (dev and test DBs) | Verified locally |

| `npm run db:seed` | Verified locally |

| `npm run ai:smoke`, `npm run e2e:brand-memory -- <candle.jpg> <crochet.jpg>`, `npm run e2e:regenerate -- <photo.jpg>` (real Claude, a few cents; the e2e scripts use the `*_test` DB) | Verified |

- Tests cover gateway success, gateway rejection, validation, rate limits and privacy. The old fake SMTP sink and Nodemailer dependency have been removed. Actual Preview delivery is still pending and must be verified by submitting the Preview contact form and checking the Titan mailbox.

| `npm run dev` (concurrently runs `tsx watch` and Vite) | **Documented, not verified** in that session |

| `npm run db:studio` | **Documented, not verified** |

| Anything Docker, GoDaddy, or CI | **None exists / not verified** |

Notes: the session's PostgreSQL was a throwaway embedded instance outside the repo; use your own (README lists brew/Docker options). Run files with `--test-concurrency=1` (the `npm test` script does) because tests share one database. **The React UI has never been exercised in a real browser**; it typechecks and builds, and every backend endpoint behind it is tested.

## 8. Current Git state (inspected)

- Branch `main`; remote `origin` → `github.com/Aashi-21/gharse`.

- Latest commit: `d9b1b04 Build public storefront and customer order workflow`; previous `8e6eb99`, `7c2ed41`, `2aeca02`.

- Latest local verification on 19 Nov 2026: npm run typecheck passed for server and web; npm test passed 353/353. Push only the Preview branch after final checks and approval.

- `.env`, `.env.*` (except `.env.example`), `uploads/`, `server/public/`, `dist/`, `node_modules/` are git-ignored; `.env` is untracked.

## 9. Hackathon deadline and requirements

- **Submission: 20 November 2026.** Today is 17 November.

- Required: **live GoDaddy deployment**, **GoDaddy-purchased domain** with DNS, **HTTPS**, **domain mailbox**, **working contact form delivering to that mailbox**, live link, GitHub repository, project brief.

- **Hosting allocation is NOT confirmed** by the organisers as of 17 November 2026. Do not assume Node.js hosting or a VPS; the app is built to support either (see §12) but neither has been tried.

## 10. Deployment readiness audit

| # | Item | Status | Evidence |

|---|---|---|---|

| 1 | Contact form | IMPLEMENTED; Preview delivery pending | POST /api/contact and /contact exist. The GoDaddy gateway adapter is covered by automated tests; the latest full run passed 353/353 tests. Not yet verified: a real contact-form submission from the GoDaddy Preview URL arriving in hello@mygharse.store. |

| 2 | Domain mailbox / email gateway | Mailbox provisioned; Preview delivery test pending | Titan mailbox hello@mygharse.store has been purchased and send/receive tested. The app uses GoDaddy's local email gateway, not external SMTP. email: configured means CONTACT_TO is present; it does not prove delivery. |

| 3 | Production PostgreSQL | **MISSING / NEEDS CONFIRMATION** | `DATABASE_URL` is supported (external DB, SSL via URL params) but nothing is provisioned and no compose file exists. GoDaddy shared Node hosting is believed to offer MySQL only (assumption, unverified). |

| 4 | Image storage survives redeploys | **MISSING / NEEDS CONFIRMATION** | Only a local-disk driver exists (`STORAGE_DRIVER` accepts `local` only; no S3/R2 driver). `uploads/` is git-ignored so deploys won't ship it, but a host that replaces the app directory would lose it unless `UPLOAD_DIR` points outside it. Product publishing verifies the file exists, so lost files would block publishing and 404 images. |

| 5 | GoDaddy Node.js hosting | Provisioned; Preview app running | GoDaddy Node.js Hosting Economy with Node 22; app connected to GitHub. Preview /api/health has returned 200. Real contact-form delivery through the local gateway remains to be verified. |

| 6 | Docker VPS support | **MISSING** | No `Dockerfile`, `docker-compose.yml`, `.dockerignore`, Caddy/nginx config, or CI in the repo. README mentions Docker only for a local Postgres. |

| 7 | Production migrations | **DOCUMENTED, not run in production** | `npm run db:deploy` → `prisma migrate deploy`; `prisma` is a runtime dependency; applied cleanly to local dev/test DBs, `migrate diff` shows no drift. Not wired into any start script or container entrypoint. |

| 8 | Secrets handling | **VERIFIED (repo side)** | `.env` untracked and ignored; `.env.example` has empty/placeholder values; env validated with zod at startup. Host-side secret injection is hosting-dependent. |

| 9 | Health check | VERIFIED | Preview /api/health has returned 200. Email status is configuration-only (configured when CONTACT_TO is set), not a delivery test. |

| 10 | Proxy settings | **NEEDS CONFIRMATION** | `TRUST_PROXY` default `false`, documented in `.env.example` and README, tested both ways. The right value depends on the real GoDaddy proxy. |

| 11 | CORS / origin checks | **VERIFIED, with a deploy caveat** | No CORS (same-origin SPA); cross-origin POSTs → 403 (tested). `APP_URL` must equal the public origin exactly; a proxy that rewrites `Host` while `APP_URL` is wrong would 403 all POSTs. |

| 12 | HTTPS | **NEEDS CONFIRMATION** | App sets Secure cookies/HSTS when `APP_URL` is `https://…` but does not terminate TLS; certificates must come from the host or a proxy. |

| 13 | Domain purchase / DNS | COMPLETED | mygharse.store is connected to the Published GoDaddy app; HTTPS was confirmed. Do not change these settings during Preview email work. |

| 14 | GoDaddy deployment | Preview and Published app exist | Preview URL: https://g64mjtmn1k.preview.c35.airoapp.ai. Published app URL: https://g64mjtmn1k.c35.airoapp.ai. Custom domain https://mygharse.store is connected to Published. Work only in Preview until its email test passes. |

| 15 | GitHub repo | **VERIFIED** | `origin` = `github.com/Aashi-21/gharse`, history through `d9b1b04`. |

| 16 | Project brief and demo script | **MISSING** | README documents features but no brief or demo script exists. |

**Conclusion:** GoDaddy Node.js hosting, the domain, HTTPS, Neon PostgreSQL and the Titan mailbox have been provisioned. The remaining email blocker is to verify real contact-form delivery from the GoDaddy Preview environment using the local gateway. Do not change Publish or the custom domain while resolving Preview. Image-storage persistence and final production readiness checks remain separate deployment considerations.

## 11. Known limitations and risks

**Remaining blockers (for the submission):** verify Preview contact-form delivery to hello@mygharse.store; finish final build and Preview smoke checks; confirm persistent image-storage behaviour; complete the project brief/demo materials and final submission. GoDaddy Node.js hosting, domain, HTTPS, Neon PostgreSQL and the Titan mailbox are already provisioned.

**Verification gaps:** the React UI (storefront, checkout form, orders pages, review/regenerate flows, image resizing) has never been run in a browser; end-to-end behaviour is covered by backend tests and curl-level smoke tests only. Nothing has run on GoDaddy infrastructure.

**Product/behaviour limitations:**

- Link previews: pages are a client-rendered SPA, so shared store links (WhatsApp) show no brand name/image; SEO metadata is not implemented.

- Stock edits: a seller's `PATCH` sets stock absolutely, so an edit racing an order is last-write-wins.

- AI: the claim guard is a regex list and cannot catch subtle inferences (e.g. calling an item a "basket" or "home storage" when Claude itself asked what it is). Photo misreadings happen (e.g. candle colours). Seller review plus the explicit publish confirmation are the real safeguards. Haiku and `MARKETING`/`IMAGE_ANALYSIS` kinds are unused; the marketing module was never built.

- The per-phone checkout limit counts cancelled orders too.

- The order confirmation page is built from client state; a refresh loses it (by design: no tracking endpoint).

- Public pages still call `/api/auth/me` and get an expected 401 for visitors.

- A live store whose last product is unpublished stays live showing "No products".

- No password reset, email verification, customer email/SMS notifications, order lookup for customers, or admin tooling.

- `npm audit` reports only the Prisma **CLI**'s `deepmerge-ts` (build/migrate tooling, not request path); the suggested fix would downgrade Prisma.

**Optional polish (not blockers):** cart, tracking token, SEO/OG tags, marketing captions, Haiku usage, S3/R2 storage driver (becomes a blocker if hosting has no persistent disk), seller email notifications.

## 12. Next steps (prioritised)

**0. Confirm current Preview state.** GoDaddy Node.js Hosting Economy (Node 22), the Preview app, Neon PostgreSQL, mygharse.store and Titan mailbox hello@mygharse.store are already provisioned. Keep all work on Preview; do not touch Publish or the custom domain while the email test is pending.

**1. Contact form: code implemented; Preview verification remains.** Ensure Preview has CONTACT_TO=hello@mygharse.store. Remove obsolete SMTP secrets from Preview only after confirming no code references them. Deploy the fix/neon-websocket branch to Preview, check /api/health, submit /contact on the Preview URL, and verify the message arrives in Titan with the visitor address as Reply-To. Do not use the health endpoint as proof of delivery. Do not sync or modify Publish yet.

**2. Image storage decision.** If the host has a persistent disk: set `UPLOAD_DIR` outside the app directory and document backups. If not: implement an S3-compatible driver behind the existing `Storage` interface (`put/get/delete/stat/check`), add it to `STORAGE_DRIVER`, test it.

**3a. If GoDaddy provides Node.js (cPanel) hosting:** external PostgreSQL (e.g. Neon/Supabase; add `?sslmode=require`) → `npm ci` and `npm run build` on the host (or build locally and upload `server/dist`, `server/public`, `server/prisma`, `package*.json`) → set env vars in the Node app UI (`NODE_ENV=production`, `APP_URL`, `DATABASE_URL`, `UPLOAD_DIR`, `ANTHROPIC_API_KEY`, CONTACT_TO, `TRUST_PROXY`) → `npm run db:deploy` → startup file `server/dist/server.js` → check `/api/health`. Verify Prisma engine loads and outbound calls work on day 1.

**3b. If GoDaddy provides a Docker VPS:** write a multi-stage `Dockerfile` (build web + server, `prisma generate`, run `db:deploy` on start, `node server/dist/server.js`), `docker-compose.yml` (app, `postgres` with a named volume, a volume for `UPLOAD_DIR`) and a Caddy (or nginx) reverse proxy for automatic HTTPS; set `TRUST_PROXY=true` only because the proxy is yours; `pg_dump` backup note.

**4. Preview-to-Publish promotion (only after Preview passes).** Once real Preview contact-form delivery is confirmed and the rest of the Preview smoke tests pass, review the required Publish environment values separately. Only then decide whether to sync secrets and deploy. Keep the existing custom domain and HTTPS configuration unchanged.

**5. Seed/demo data:** `ALLOW_SEED=true npm run db:seed` once for the Demo store (optional) and create one real seller store for the demo; keep the Anthropic key in the host environment only.

**6. Browser pass:** click through the whole journey on the live URL; fix UI defects.

**7. Submission materials:** project brief, demo script, final README, live link, repo link.

## 13. How to resume (paste into a fresh Claude Code session)

```text

Read docs/PROJECT_HANDOFF.md and README.md. GharSe is deployed on GoDaddy Node.js Hosting (Node 22); the Preview app is https://g64mjtmn1k.preview.c35.airoapp.ai. The Published app and https://mygharse.store already exist; do not touch Publish, Publish secrets, or the custom domain until Preview email delivery has been verified. The contact form uses GoDaddy's local email gateway and CONTACT_TO=hello@mygharse.store, not SMTP/Nodemailer. Latest local verification on 19 Nov 2026: npm run typecheck passed and npm test passed 353/353. First run git status and git log --oneline -5; never read or print .env or API keys. Finish README/handoff cleanup, run npm run build, re-run tests if code changes, then stage only reviewed files and push only fix/neon-websocket after approval. Deploy/test Preview, submit the contact form and confirm receipt in Titan plus Reply-To. Do not claim delivery based only on /api/health. Work incrementally and do not commit, push, sync secrets or deploy Publish without approval.

```