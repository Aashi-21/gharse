#!/usr/bin/env node
/**
 * ONE-SHOT, READ-ONLY database diagnostic for a hosted environment (for example the GoDaddy Node.js runtime).
 * Temporary tooling for the MySQL migration decision. It is not part of the application.
 *
 *   GHARSE_DB_INSPECT=READ_ONLY_ONCE node tools/db-inspect/run-on-host.cjs
 *
 * Needs DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD in the environment (their values are never printed).
 *
 * What it does, in order:
 *  1. Refuses to run unless the guard variable is set (so it can never run by accident).
 *  2. If PORT is set (a platform that expects a web server), starts a tiny listener that returns ONE FIXED SENTENCE for
 *     every request. No diagnostic result, database detail or environment value is ever served over HTTP.
 *  3. Runs the already-tested inspector (inspect.cjs) as a CHILD PROCESS, once, with a hard time limit. Everything the
 *     child writes to stdout OR stderr (including output from the native Prisma engine, which can bypass Node) is collected
 *     and redacted here before anything is printed. Results go to the runtime logs only.
 *  4. Idles for a limited time (so the logs can be read), then exits by itself.
 *
 * It never runs migrations, creates tables, alters schema or writes data: the inspector sends only SELECT/SHOW, on a
 * session the server has been told is READ ONLY. The only file this runner writes is a marker in the OS temp folder.
 */
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { redact, NEEDED } = require('./inspect.cjs');

const GUARD_VAR = 'GHARSE_DB_INSPECT';
const GUARD_VALUE = 'READ_ONLY_ONCE';
const clamp = (v, dflt, min, max) => Math.min(max, Math.max(min, Number(v) || dflt));
const RUN_SECONDS = clamp(process.env.GHARSE_DB_INSPECT_MAX_SECONDS, 120, 20, 600); // hard limit for the inspection itself
const IDLE_SECONDS = clamp(process.env.GHARSE_DB_INSPECT_IDLE_SECONDS, 600, 0, 1800); // how long to stay up so logs can be read
const MARKER = path.join(os.tmpdir(), 'gharse-db-inspect.done');
const STUB_BODY = 'GharSe database diagnostic finished. Nothing is served here. Read the runtime logs, then redeploy the application.\n';
const GENERATE_ARGS = ['generate', '--schema', path.join(__dirname, 'schema.prisma')]; // writes only ./.client; never connects to a database

const log = (text) => process.stdout.write(redact(text) + '\n');

/** Runs a child with a hard timeout and returns its COMBINED stdout+stderr, redacted. Nothing from the child reaches our output unredacted. */
function runRedacted(args, { timeoutMs, env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let output = '';
    let timedOut = false;
    const cap = (d) => { if (output.length < 200_000) output += d.toString('utf8'); };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const done = (code) => { clearTimeout(timer); resolve({ code: timedOut ? 124 : code, timedOut, output: redact(output) }); };
    child.on('error', () => done(127));
    child.on('close', (code) => done(code ?? 1));
  });
}

/** A web server that says the same fixed sentence to everyone. It has no access to results. */
function startStub(port, host = '0.0.0.0') {
  const server = http.createServer((req, res) => {
    const readOnlyMethod = req.method === 'GET' || req.method === 'HEAD';
    res.writeHead(readOnlyMethod ? 200 : 405, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(STUB_BODY),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    });
    res.end(req.method === 'HEAD' ? undefined : STUB_BODY);
  });
  server.on('clientError', (_e, socket) => socket.destroy());
  server.listen(/^\d+$/.test(String(port)) ? Number(port) : port, host);
  return server;
}

async function selfTest() {
  const fake = { DB_HOST: 'db.example.test', DB_PORT: '3306', DB_NAME: 'cpuser_gharse', DB_USER: 'cpuser', DB_PASSWORD: 'p@ss/w0rd!' };
  Object.assign(process.env, fake);
  const results = [];
  const check = (name, pass) => results.push([name, !!pass]);

  // 1. child output on stdout AND stderr is redacted, including the URL-encoded password and raw (non-Node) writes
  const noisy = "process.stdout.write('host db.example.test user cpuser db cpuser_gharse\\n'); process.stderr.write('pw ' + encodeURIComponent('p@ss/w0rd!') + ' and mysql://cpuser:x@db.example.test/y raw p@ss/w0rd!\\n'); require('fs').writeSync(2, 'native-style write p@ss/w0rd! cpuser\\n');";
  const r = await runRedacted(['-e', noisy], { timeoutMs: 5000 });
  const leaked = ['db.example.test', 'cpuser', 'cpuser_gharse', 'p@ss/w0rd!', encodeURIComponent('p@ss/w0rd!')].filter((v) => r.output.includes(v));
  check('child stdout, stderr and raw fd writes are redacted before printing', leaked.length === 0 && r.output.includes('<redacted>'));

  // 2. hard timeout kills a child that never finishes
  const started = Date.now();
  const slow = await runRedacted(['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 1000 });
  check('a child that hangs is killed at the time limit', slow.timedOut && Date.now() - started < 5000);

  // 3. the listener returns one fixed sentence for every path/method and nothing else
  const server = startStub(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const get = (p, method = 'GET') => new Promise((resolve) => { const q = http.request({ port, host: '127.0.0.1', path: p, method }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); q.end(); });
  const bodies = await Promise.all(['/', '/api/health', '/?db=cpuser_gharse', '/../../etc/passwd', '/tools/db-inspect/.client', '/%00'].map((p) => get(p)));
  check('listener answers every path with the same fixed sentence', bodies.every((b) => b.status === 200 && b.body === STUB_BODY));
  check('listener never contains any environment value', bodies.every((b) => !Object.values(fake).some((v) => b.body.includes(v))));
  const post = await get('/', 'POST');
  check('listener refuses non-GET methods without echoing anything', post.status === 405 && post.body === STUB_BODY);
  server.close();

  // 4. the guard: without the variable it refuses and prints no secrets; it never reaches the database
  const refuse = await runRedacted([__filename], { timeoutMs: 8000, env: { ...process.env, [GUARD_VAR]: '' } });
  check('refuses to run without the guard variable (exit 2), no secrets printed', refuse.code === 2 && /Refusing to run/.test(refuse.output) && !refuse.output.includes('p@ss'));

  // 5. static guards on this runner's own source
  const src = fs.readFileSync(__filename, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const banned = ['mi' + 'grate', 'db ' + 'push', 'schema-' + 'engine', '$query' + 'Raw', '$execute' + 'Raw'];
  check('source: no database client, raw SQL, or schema-migration tooling in the runner', !banned.some((w) => code.includes(w)));
  check('source: the only Prisma CLI call is "generate" against the tools schema', JSON.stringify(GENERATE_ARGS.map((a, i) => (i === 2 ? path.basename(a) : a))) === JSON.stringify(['generate', '--schema', 'schema.prisma']));
  const write = 'writeFile' + 'Sync(';
  check('source: exactly one file write (the marker in the OS temp folder)', code.split(write).length - 1 === 1 && code.includes(write + 'MARKER'));
  const production = ['package' + '.json', 'server' + '/', 'web' + '/', 'load' + 'EnvFile'];
  const read = 'readFile' + 'Sync(';
  // the only file read is this self-test reading its own source
  check('source: no production file, manifest or env loading is referenced, and no other file is read', !production.some((w) => code.includes(w)) && code.split(read).length - 1 === 1);

  let ok = true;
  for (const [name, pass] of results) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); ok = ok && pass; }
  console.log(ok ? '\nrunner self-test OK' : '\nrunner self-test FAILED');
  process.exit(ok ? 0 : 1);
}

async function main() {
  if (process.argv.includes('--selftest')) return selfTest();

  if (process.env[GUARD_VAR] !== GUARD_VALUE) {
    log(`Refusing to run: set ${GUARD_VAR}=${GUARD_VALUE} to confirm this one-time, read-only diagnostic.`);
    process.exit(2);
  }
  const missing = NEEDED.filter((k) => !process.env[k]);
  if (missing.length) {
    log(`Missing environment variables: ${missing.join(', ')}`);
    process.exit(2);
  }

  // Auto-exit no matter what happens below.
  setTimeout(() => { log('Diagnostic runner stopped (time limit).'); process.exit(0); }, (RUN_SECONDS + IDLE_SECONDS + 90) * 1000).unref();

  const stub = process.env.PORT ? startStub(process.env.PORT, process.env.HOST || '0.0.0.0') : null;
  log(`GharSe read-only database diagnostic starting (limit ${RUN_SECONDS}s${stub ? `, then idle ${IDLE_SECONDS}s` : ''}).`);

  if (fs.existsSync(MARKER)) {
    log('The diagnostic already ran in this container, so it will not run again. Delete the marker file in the OS temp folder to repeat it.');
  } else {
    // Environment for the client generator: it needs no database access, so it gets none of the DB_* values.
    const noDb = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('DB_') && k !== GUARD_VAR));
    if (!fs.existsSync(path.join(__dirname, '.client'))) {
      let cli;
      try { cli = require.resolve('prisma/build/index.js', { paths: [path.join(__dirname, '..', '..')] }); } catch { cli = null; }
      if (!cli) {
        log('The Prisma CLI is not installed here, so the read-only client cannot be generated. Run the generate step in the build (see README).');
      } else {
        log('Generating the isolated read-only client (no database connection is made)...');
        const gen = await runRedacted([cli, ...GENERATE_ARGS], { timeoutMs: 90_000, env: noDb });
        log(gen.output.trim().split('\n').slice(-6).join('\n'));
        if (gen.code !== 0) log(`Client generation exited with code ${gen.code}.`);
      }
    }
    log('--- inspection report (redacted) ---');
    const run = await runRedacted([path.join(__dirname, 'inspect.cjs')], { timeoutMs: RUN_SECONDS * 1000 });
    log(run.output.trimEnd());
    log(`--- end of report (inspector exit code ${run.code}${run.timedOut ? ', stopped at the time limit' : ''}) ---`);
    fs.writeFileSync(MARKER, new Date().toISOString());
  }

  if (!stub) process.exit(0);
  log(`Done. Staying up for ${IDLE_SECONDS}s so the logs can be read, then exiting. Redeploy the application afterwards.`);
  setTimeout(() => process.exit(0), IDLE_SECONDS * 1000);
}

main().catch((e) => { log('Unexpected error: ' + (e && e.message ? String(e.message).split('\n').slice(-1)[0] : e)); process.exit(1); });
