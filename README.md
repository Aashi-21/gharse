# GharSe

Launch your handmade brand online. React + Vite + Tailwind frontend, Fastify + Prisma + PostgreSQL backend, one Node process serves both.

**Status:** auth, onboarding, AI brand creation with persistent brand memory, and AI product drafts from a photo, answering Claude's questions and regenerating, and publishing/unpublishing products. A public seller storefront and customer order management (no online payment).

## Requirements
- Node.js >= 20.17, npm >= 10
- PostgreSQL 14+ (local, Docker, or external such as Neon/Supabase)

## Local setup
```bash
npm install
cp .env.example .env            # then edit DATABASE_URL / TEST_DATABASE_URL

# Create two empty databases first (e.g. gharse and gharse_test), then:
npm run db:migrate              # creates tables (prisma migrate dev)
npm run db:seed                 # optional: ONE clearly-labelled SAMPLE seller + store + 3 products
npm run dev                     # API on :3000, web on http://localhost:5173
```
Quick local Postgres options: `brew install postgresql@16 && brew services start postgresql@16`, or Docker:
`docker run -d --name gharse-pg -e POSTGRES_USER=gharse -e POSTGRES_PASSWORD=gharse -e POSTGRES_DB=gharse -p 5432:5432 postgres:16`
(then `createdb`/`CREATE DATABASE gharse_test`).

## Test
```bash
# applies migrations to the test DB once, then runs the suite (tests TRUNCATE tables; DB name must end in _test)
DATABASE_URL=$TEST_DATABASE_URL npm run db:deploy
npm test
npm run typecheck
```

## Production-style run (what GoDaddy Node hosting runs)
```bash
npm ci && npm run build         # builds web into server/public, compiles server to server/dist
npm run db:deploy               # prisma migrate deploy
PORT=3000 NODE_ENV=production npm start
```
Startup file for cPanel "Setup Node.js App": `server/dist/server.js` (CommonJS, reads `PORT`).

## Health check
`GET /api/health` → `200 {status:"ok", checks:{database, storage, email, ai}}` or `503` when the database or storage fails.
`email` is `ok | fail | not_configured` (SMTP verify, cached 60 s); no error details or secrets are exposed.

## Sample data
`npm run db:seed` creates `sample.seller@gharse.example` with `isSample=true` on the user and store, and "(Sample)" in all names. The dashboard shows a "sample account" banner. Refuses to run in production unless `ALLOW_SEED=true`.

## Security notes
- Passwords: scrypt (node:crypto). Sessions: random 256-bit token in an httpOnly, SameSite=Lax cookie (Secure when `APP_URL` is https); only its SHA-256 is stored.
- Mutating requests must come from the app's own origin; auth routes are rate limited.
- Known, accepted: `npm audit` reports `deepmerge-ts` inside the Prisma **CLI** (build/migrate tooling only, not the request path).

## AI product drafts (Phase 2)
`Dashboard → Products → Add a product`: choose one photo (resized in the browser to <=1568px JPEG), optionally add facts about the product, and Claude drafts a title, description, category, tags, what it can see, and questions for what it cannot know.

- The seller's **approved brand is loaded from PostgreSQL on every request** (409 `brand_required` if none). No conversation history is used.
- Claude may only use what is visible in the photo and what the seller typed. A code-level guard (`server/src/modules/ai/claimGuard.ts`) rejects invented claims (materials, sizes, scent, handmade, eco, price, what is included...) unless the seller's own notes state them; one corrective retry, then nothing is saved.
- Drafts are saved as `DRAFT` with price empty and stock 0. Nothing is published automatically.
- Images are validated by magic bytes, dimensions (32-8000px) and size (<=5 MB), stored via the storage abstraction (`UPLOAD_DIR`), never in PostgreSQL, under server-generated paths.

### Verify locally
```bash
DATABASE_URL=$TEST_DATABASE_URL npm run db:deploy   # applies the new migration to the test DB
npm run db:migrate                                   # applies it to the dev DB
npm test && npm run typecheck && npm run build
npm run ai:smoke                                     # real Claude: brand generation (a few cents)
npm run e2e:brand-memory -- /path/to/candle.jpg /path/to/crochet.jpg   # real Claude: full brand-memory scenario, uses the *_test DB
npm run dev                                          # then use the UI at http://localhost:5173
```

## Product completion and publishing (Phase 3, milestone 1)
- **Publish** (`POST /api/seller/products/:id/publish`, body `{ "confirmAccuracy": true }`, required by the API) needs: title, description of at least 20 characters, category, price > 0, stock >= 1 and a photo whose file is verified in storage at publish time (exists, is a file, non-empty, exactly the size recorded at upload; metadata only, no contents read, nothing in the response reveals paths). Tags are optional. Missing items come back as a 400 `not_publishable` with per-field messages; nothing is ever auto-filled. The check runs on a row-locked product inside one transaction.
- **Unpublish** returns the product to `DRAFT` unchanged. **Live products** can still be edited, but every edit must keep them publishable (stock may drop to 0 for sold out).
- **Regenerate** (`POST /api/seller/products/:id/regenerate`, drafts only): the seller's answers to Claude's questions are sent with the saved photo and the current approved brand. It overwrites only the AI-owned fields (title, description, category, tags, visible characteristics, open questions); price, stock, notes and earlier answers are preserved. The claim guard treats only the seller's notes and answers as facts (not Claude's own questions). Any failure leaves the product unchanged.
- Publishing a product does **not** change `Store.isPublished`; the public storefront milestone owns that. Any future customer-facing query must use `PUBLIC_PRODUCT_FILTER` (`server/src/modules/products/visibility.ts`) so DRAFT and ARCHIVED products are never exposed.
- The database also enforces it: CHECK constraints reject a PUBLISHED row without a positive price, a real title or `publishedAt`, and negative stock.

Live check (real Claude, a few cents, uses the `*_test` database): `npm run e2e:regenerate -- /path/to/photo.jpg`

## Public storefront and orders (Phase 3, milestone 2)
- **Store settings and publishing** (`Dashboard → Store`): contact phone (shown publicly only if the seller types it; never copied from the private profile), one flat delivery charge, delivery and return policies. A store goes public only with an approved brand, a contact phone, both policies and at least one published product. Store publication is separate from product publication.
- **Public store** at `/store/:slug` and product pages at `/store/:slug/p/:productSlug` (React routes served by the same Node process), backed by `/api/public/stores/...`. Only PUBLISHED products of a PUBLISHED store are visible; an unpublished store, a draft product, a missing image file and a store that does not exist all return the same generic 404. Responses use a field whitelist (no ids, seller details or exact stock) and are not cached.
- **Checkout** (`POST /api/public/stores/:slug/orders`): single product, no customer account, **no payment is collected** (cash on delivery or whatever the customer and seller arrange). Required header `Idempotency-Key` (8-64 chars `A-Za-z0-9_-`) makes retries and double-clicks safe: same key = same order, stock taken once. Every price, delivery charge and total is computed on the server; the request schema is strict, so a client-supplied price, total or status is rejected. Stock is reserved at order creation (one atomic conditional update, so concurrent buyers can never oversell) and returned when the seller cancels.
- **Customer privacy:** name, phone, address and note are returned or shown only to the owning seller (`/api/seller/orders`). They are never in any public response, and error logs for the checkout route record only the error class and code.
- **Demo store:** the seeded sample store is public with a "Demo store" banner and cannot take orders.
- **Seller orders** (`Dashboard → Orders`): list with status filter and pagination, detail, and safe status changes NEW → CONFIRMED → SHIPPED → DELIVERED, or CANCELLED before shipping (restocks exactly once, transactionally). A badge shows NEW orders.

### Abuse limits and TRUST_PROXY (read before deploying)
Public checkout is limited per client IP (`ORDER_RATE_LIMIT_MAX`, default 10 per minute), per phone number per store (`ORDER_PHONE_HOURLY_LIMIT`, default 3 per hour) and per store (`ORDER_STORE_HOURLY_LIMIT`, default 100 per hour).

The per-IP limit depends on knowing the visitor's real IP, which behind a reverse proxy arrives in `X-Forwarded-For`. The app **does not trust that header unless `TRUST_PROXY=true`**:
- App directly exposed to the internet: leave `TRUST_PROXY=false`, or anyone could fake their IP.
- App behind a proxy you control (Caddy/nginx/Apache/Passenger on your own host, which overwrites the header): set `TRUST_PROXY=true`, otherwise every visitor shares the proxy's IP and one limit.
- Confirm which applies to your GoDaddy hosting before going live. If unsure, keep it `false`; the per-phone and per-store limits still apply.

Live acceptance (what was run): the compiled build over real HTTP with 15 parallel buyers for 4 units (4 orders, 11 sold-out refusals, stock 0), same-key duplicate storms (one order), cancel/restock, and spoofed forwarded IPs with the default settings.

## Contact form (`/contact`)

The public contact page posts to `POST /api/contact`. The server sends messages through GoDaddy Node.js Hosting's local email gateway using `server/src/lib/emailGateway.ts` and `server/src/lib/mailer.ts`.

**Behaviour**
- The page displays "Message sent" only after the email gateway accepts the message.
- Fields: `name` (2-80), `email` (valid, at most 254), `subject` (3-120), `message` (10-2000), and a hidden honeypot field `website`.
- Outcomes: `200 {sent:true}` on successful delivery; `400` validation or honeypot; `413` oversized request; `429` rate limited; `502 contact_failed` delivery failure; `503 contact_unavailable` when email is not configured.
- Visitor name, email and message are never logged. Delivery failures log only safe error information.
- Messages are plain text, addressed to `CONTACT_TO`, with the visitor's email set as `Reply-To`.
- GoDaddy selects the sender address; the application does not configure an SMTP sender.

**Configuration**
- Set `CONTACT_TO` in the server environment to the mailbox that should receive contact messages.
- Email delivery uses GoDaddy's local gateway at `127.0.0.1:2525` through the official hosting helper.
- No SMTP credentials or external email provider are required.
- `CONTACT_RATE_LIMIT_MAX` (default 10 requests per client IP per hour).
- `CONTACT_HOURLY_LIMIT` (default 60 messages per hour across all visitors).
- `CONTACT_SEND_TIMEOUT_MS` (default 15000).

**Testing**
- Run automated tests with `npm test`.
- The contact-form tests mock the GoDaddy gateway and cover successful delivery, failure handling, validation, rate limits and privacy.
- Verify actual email delivery by submitting the contact form in the GoDaddy Preview environment and confirming receipt at the configured mailbox. The health endpoint's `email: configured` status confirms configuration only; it does not test delivery.