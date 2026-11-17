# GharSe

Launch your handmade brand online. React + Vite + Tailwind frontend, Fastify + Prisma + PostgreSQL backend, one Node process serves both.

**Status:** auth, onboarding, AI brand creation with persistent brand memory, and AI product drafts from a photo (upload, Claude vision, review, edit, save as draft). Publishing, the public storefront and orders are not built yet.

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
