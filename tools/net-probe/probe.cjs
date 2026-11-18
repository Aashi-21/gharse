#!/usr/bin/env node
/**
 * TEMPORARY, ISOLATED network diagnostic for the GoDaddy Preview runtime. It is not part of the application.
 *
 * Why it exists: the app reports "Can't reach database server" in about 30 ms. This checks, from the real runtime, whether
 * DNS, TCP port 5432 and the PostgreSQL TLS handshake to the Neon host work, and what the failure is if they do not.
 *
 * It runs from npm's `prestart` hook, so the `start` command is unchanged, and ONLY when GHARSE_NET_PROBE=ONCE.
 *   GHARSE_NET_PROBE=ONCE              enables it (otherwise it prints one line and does nothing)
 *   GHARSE_NET_PROBE_HOST=<hostname>   the Neon host name (not a secret, and never committed or printed)
 *   GHARSE_NET_PROBE_PORT=5432         optional
 *
 * ARCHITECTURE: `node probe.cjs` is a small SUPERVISOR. When the probe is enabled it runs the real checks (this same file, with
 * `--child`) in a separate process and enforces a hard 15 second wall-clock deadline by killing that process (SIGKILL). It then
 * exits 0 whatever happened. This is needed because Node's process.exit() waits for in-flight thread-pool work, and getaddrinfo
 * (dns.lookup) is thread-pool work: a hung resolver call would otherwise keep a single-process probe alive long after its
 * watchdog. A separate process can simply be killed.
 *
 * The child gets an EXPLICIT environment: only the three GHARSE_NET_PROBE variables and the temp-folder variables. Nothing else
 * (no DATABASE_URL, no credentials, no NODE_OPTIONS) is ever passed on. Its output is filtered and redacted again by the supervisor.
 *
 * It NEVER reads DATABASE_URL, .env or any credential, sends no database startup packet and no SQL, loads no database
 * library, adds no HTTP route and opens no listener. The only thing sent to the database port is the 8-byte PostgreSQL
 * "SSLRequest", which asks the server to switch to TLS before any login. The connection is closed straight after the handshake.
 * It prints no host name, no IP address, no environment value and no raw error message: only error codes and timings.
 * It always exits 0 (so the app starts) within the deadline, and runs once per container.
 */
'use strict';
const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');

const GUARD_VAR = 'GHARSE_NET_PROBE';
const GUARD_VALUE = 'ONCE';
const HOST_VAR = 'GHARSE_NET_PROBE_HOST';
const PORT_VAR = 'GHARSE_NET_PROBE_PORT';
const STEP_MS = 3500; // each network step; independent steps run together, so the total stays inside the budget
const HARD_DEADLINE_MS = 15000; // the supervisor kills the probe process at this wall-clock deadline
const CHILD_BUDGET_MS = 13000; // the probe's own watchdog: it reports a partial result before the supervisor's deadline
const GRACE_MS = 750; // after the probe's final line, how long the supervisor lets it exit before stopping it
const KILL_WAIT_MS = 1000; // after SIGKILL, the longest the supervisor waits to see the process go
const MAX_RELAY_LINES = 300; // the supervisor passes on at most this many probe lines
const SENTINEL = '[net-probe] ~end-of-report~'; // the probe's last line: "I have finished writing"
const MAX_ADDRESSES = 6;
const MARKER = path.join(os.tmpdir(), 'gharse-net-probe.done');
// PostgreSQL SSLRequest: Int32 length 8, Int32 request code 80877103. Nothing else is ever sent to the database port.
const SSL_REQUEST = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]);
// The ONLY environment variables the probe ever reads, and the ONLY ones its child process is given.
// (TMPDIR/TMP/TEMP are folder names, so the once-per-container marker lands in the same temp folder.)
const CHILD_ENV_NAMES = [GUARD_VAR, HOST_VAR, PORT_VAR, 'TMPDIR', 'TMP', 'TEMP'];
const ALLOWED_ENV = new Set(CHILD_ENV_NAMES);
const PROXY_VARS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const HOST_RE = /^(?=.{3,253}$)[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/; // a plain host name: rejects URLs, paths, "user:pw@", spaces

// The ONLY two places in this file that touch process.env: the allow-listed names above, and "is a proxy variable set" (never its value).
const envGet = (name) => (ALLOWED_ENV.has(name) ? process.env[name] : undefined);
const envHas = (name) => PROXY_VARS.includes(name) && !!process.env[name];

// ---------- redaction: defence in depth (lines are built from safe fields only) ----------
let secretHost = '';
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function redact(text) {
  let s = String(text);
  if (secretHost) s = s.replace(new RegExp(escapeRegExp(secretHost), 'gi'), '<host>');
  return s
    .replace(/[0-9a-f:.]*:[0-9a-f:.]*/gi, (m) => (net.isIPv6(m.replace(/%.*$/, '')) ? '<ip>' : m))
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/\b(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b/gi, '<host>');
}

// ---------- safe error reporting: codes only, never messages ----------
const CODE_RE = /^[A-Z0-9_]{2,48}$/;
const safeCode = (c) => (typeof c === 'string' && CODE_RE.test(c) ? c : 'UNKNOWN');
const safeName = (e) => (e && typeof e.name === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(e.name) ? e.name : 'Error');
const safeText = (v, max) => String(v == null ? '' : v).replace(/[^A-Za-z0-9 .,'&()_:+-]/g, '').slice(0, max);
function errCodes(e) {
  const set = new Set();
  if (e && typeof e === 'object') {
    if (e.code) set.add(safeCode(e.code));
    if (Array.isArray(e.errors)) for (const x of e.errors.slice(0, 8)) set.add(safeCode(x && x.code));
  }
  if (!set.size) set.add('UNKNOWN');
  return [...set].sort().join(',');
}
const errSys = (e) => (e && typeof e.syscall === 'string' && /^[a-z0-9_]{2,24}$/i.test(e.syscall) ? e.syscall : '-');
const withTimeout = (promise, ms) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('t'), { code: 'TIMEOUT' })), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

// ---------- address classes (so we can say "private/loopback" without printing an address) ----------
const V4_CLASSES = [['0.0.0.0', 8, 'unspecified'], ['127.0.0.0', 8, 'loopback'], ['10.0.0.0', 8, 'private'], ['172.16.0.0', 12, 'private'], ['192.168.0.0', 16, 'private'], ['100.64.0.0', 10, 'cgnat'], ['169.254.0.0', 16, 'link-local'], ['224.0.0.0', 4, 'multicast'], ['240.0.0.0', 4, 'reserved']];
const V6_CLASSES = [['::', 128, 'unspecified'], ['::1', 128, 'loopback'], ['fe80::', 10, 'link-local'], ['fc00::', 7, 'private'], ['ff00::', 8, 'multicast'], ['::ffff:0:0', 96, 'ipv4-mapped']];
function classifyIp(ip) {
  const v6 = net.isIPv6(ip);
  for (const [base, prefix, cls] of v6 ? V6_CLASSES : V4_CLASSES) {
    const list = new net.BlockList();
    list.addSubnet(base, prefix, v6 ? 'ipv6' : 'ipv4');
    if (list.check(ip, v6 ? 'ipv6' : 'ipv4')) return cls;
  }
  return 'public';
}
function summarizeClasses(ips) {
  const counts = {};
  for (const ip of ips) { const c = classifyIp(ip); counts[c] = (counts[c] || 0) + 1; }
  return Object.entries(counts).map(([c, n]) => `${c}:${n}`).join(',') || '-';
}

// ---------- network primitives ----------
/** Opens a TCP connection with a time limit. Never throws. The socket is returned open on success. */
function connectSocket(options, ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    let socket;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ms: Date.now() - started, ...r });
    };
    const timer = setTimeout(() => { if (socket) socket.destroy(); finish({ ok: false, codes: 'TIMEOUT', sys: '-' }); }, ms);
    try { socket = net.connect(options); } catch (e) { finish({ ok: false, codes: errCodes(e), sys: errSys(e) }); return; }
    socket.on('error', (e) => { socket.destroy(); finish({ ok: false, codes: errCodes(e), sys: errSys(e) }); });
    socket.once('connect', () => finish({ ok: true, socket, family: socket.remoteFamily === 'IPv6' ? 6 : 4 }));
  });
}

/**
 * PostgreSQL TLS handshake and nothing more: TCP, SSLRequest, expect "S", TLS handshake, close. No startup packet, no login, no SQL.
 * `verify` false is used ONLY for the follow-up that tells a certificate-trust problem from a network problem.
 */
async function pgTlsHandshake({ target, host, port, stepMs, verify, ca }) {
  const started = Date.now();
  const c = await connectSocket(target ? { host: target.ip, port, family: target.family } : { host, port }, stepMs);
  if (!c.ok) return { ok: false, stage: 'tcp', codes: c.codes, sys: c.sys, ms: Date.now() - started };
  const sock = c.socket;
  const answer = await new Promise((resolve) => {
    const t = setTimeout(() => resolve({ codes: 'TIMEOUT' }), stepMs);
    sock.once('data', (d) => { clearTimeout(t); resolve({ byte: d[0] }); });
    sock.once('close', () => { clearTimeout(t); resolve({ codes: 'CLOSED' }); });
    sock.write(SSL_REQUEST);
  });
  if (answer.byte !== 0x53) {
    sock.destroy();
    const answered = answer.byte !== undefined;
    return { ok: false, stage: 'sslrequest', answer: answered ? (answer.byte === 0x4e ? 'N' : 'UNEXPECTED') : undefined, codes: answered ? '-' : answer.codes, ms: Date.now() - started };
  }
  return new Promise((resolve) => {
    let done = false;
    // verify=true is the real check. The single verify=false handshake below is the labelled diagnostic follow-up.
    const t = tls.connect({ socket: sock, servername: host, rejectUnauthorized: verify, minVersion: 'TLSv1.2', ca });
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (r.ok) {
        // close politely (TLS close_notify, then FIN) so the server sees a clean, completed handshake; nothing else is sent
        t.end();
        setTimeout(() => { t.destroy(); sock.destroy(); }, 100).unref();
      } else {
        t.destroy();
        sock.destroy();
      }
      resolve({ ms: Date.now() - started, ...r });
    };
    const timer = setTimeout(() => finish({ ok: false, stage: 'tls', codes: 'TIMEOUT' }), stepMs);
    t.on('error', (e) => finish({ ok: false, stage: 'tls', codes: errCodes(e) }));
    t.once('secureConnect', () => {
      const cert = t.getPeerCertificate() || {};
      const ae = t.authorizationError;
      finish({
        ok: true,
        protocol: safeText(t.getProtocol(), 12),
        cipher: safeText(t.getCipher() && t.getCipher().name, 40),
        authorized: !!t.authorized,
        authError: ae ? safeCode(typeof ae === 'string' ? ae : ae.code) : '-',
        issuerOrg: safeText(cert.issuer && cert.issuer.O, 40),
        validTo: safeText(cert.valid_to, 30),
      });
    });
  });
}

const isCertClass = (codes) => /(^|,)(UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|CERT_|ERR_TLS_CERT|HOSTNAME_MISMATCH)/.test(codes || '');
const okOrFail = (r) => (r.ok ? 'OK' : 'FAIL');
const failDetail = (r) => `codes=${r.codes}${r.sys && r.sys !== '-' ? ` syscall=${r.sys}` : ''}`;

/** Plain-language reading of the collected facts (pure: no I/O). Only fixed sentences plus error codes. */
function buildVerdicts(f) {
  const v = [];
  if (!f.dnsOk) v.push('DNS resolution fails in this runtime: the resolver is blocked or misconfigured.');
  else if (f.tcpAny || f.hyperOk) {
    if (f.tls && f.tls.ok && f.tls.authorized) v.push('DNS, TCP and a verified TLS handshake all succeed: the network path to the database is fine. Look at the Prisma engine environment (engine, OpenSSL, system CA store) or the exact database connection string value.');
    else if (f.tls && f.tls.stage === 'sslrequest' && f.tls.answer === 'N') v.push('TCP works but the server declined TLS (answered N).');
    else if (f.tls && f.tls.stage === 'sslrequest') v.push(`TCP works but the server did not answer the TLS request properly (${f.tls.answer || f.tls.codes}).`);
    else if (f.tlsUnverified && f.tlsUnverified.ok) v.push(`TCP works, but certificate verification fails (${f.tls.codes}) while an unverified handshake succeeds: a CA-store or clock problem in this runtime.`);
    else if (f.tls) v.push(`TCP works but the TLS step fails (${f.tls.stage}, ${f.tls.codes}).`);
    if (f.families.length && f.failedFamilies.some((x) => !f.families.includes(x))) v.push(`Only IPv${f.families.join('/IPv')} addresses connect; the other family fails, so a client that tries it first may fail quickly.`);
    if (!f.hyperOk && f.tcpAny) v.push('Individual addresses connect but the default connect does not.');
  } else if (f.dnsSuspicious) v.push('DNS returns only loopback, private or unspecified addresses for this host: DNS is filtered or hijacked in this runtime.');
  else if (f.sameHostOk) v.push('Port 5432 is NOT reachable but port 443 to the same host is: outbound 5432 is blocked in this runtime, so the 443 (WebSocket) route or another host is needed.');
  else if (f.otherHostOk) v.push('Neither 5432 nor 443 reaches this host while another HTTPS host works: a host- or address-specific block, or an IPv4/IPv6 family problem (see the per-address lines).');
  else v.push('No outbound connection works at all: general outbound access is blocked.');
  return v;
}

// ---------- the run ----------
const MSG_INACTIVE = 'inactive (set GHARSE_NET_PROBE=ONCE to run this one-time network diagnostic)';
const MSG_BAD_HOST = 'not run: GHARSE_NET_PROBE_HOST is missing or is not a plain host name (its value is never printed)';

/** The supervisor's first look: is the probe enabled at all, and is the host value a plain host name? (no child is started otherwise) */
function precheck(get) {
  if ((get(GUARD_VAR) ?? '').trim() !== GUARD_VALUE) return { run: false, message: MSG_INACTIVE };
  const host = (get(HOST_VAR) ?? '').trim();
  if (!HOST_RE.test(host)) return { run: false, message: MSG_BAD_HOST };
  return { run: true, host };
}

/** The child's environment: the allow-list and nothing else. */
function buildChildEnv(get) {
  const env = {};
  for (const name of CHILD_ENV_NAMES) {
    const value = get(name);
    if (typeof value === 'string' && value !== '') env[name] = value;
  }
  return env;
}

function parsePort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 5432;
}

async function runProbe(o) {
  const stepMs = o.stepMs ?? STEP_MS;
  let finished = false;
  let watchdog;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    o.exit(0);
  };
  const log = (text) => { if (!finished) o.log('[net-probe] ' + redact(text)); };

  try {
    // (hosting panels sometimes add a stray space or newline to a value, so values are trimmed before they are checked)
    if ((o.get(GUARD_VAR) ?? '').trim() !== GUARD_VALUE) { log(MSG_INACTIVE); return finish(); }
    const host = (o.get(HOST_VAR) ?? '').trim();
    if (!HOST_RE.test(host)) { log(MSG_BAD_HOST); return finish(); }
    const port = parsePort(o.get(PORT_VAR));
    secretHost = host;
    if (o.marker && fs.existsSync(o.marker)) { log('already ran in this container, so it will not run again (delete the marker file in the OS temp folder to repeat)'); return finish(); }
    if (o.marker) { try { fs.writeFileSync(o.marker, new Date().toISOString()); } catch { /* not fatal */ } }
    watchdog = setTimeout(() => { log(`watchdog: stopped after ${o.totalMs / 1000}s; the lines above are partial`); finish(); }, o.totalMs);
    if (watchdog.unref) watchdog.unref();
    log(`start: port=${port} step_limit=${stepMs}ms total_limit=${o.totalMs}ms (host name, addresses and values are never printed)`);

    // 0. environment
    const ifaces = Object.values(os.networkInterfaces()).flat().filter((i) => i && !i.internal);
    const resolvers = dns.getServers().map((s) => s.replace(/^\[|\](:\d+)?$/g, '').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1'));
    log(`env: node=${process.versions.node} openssl=${process.versions.openssl} platform=${process.platform}-${process.arch} utc_date=${new Date().toISOString().slice(0, 10)}`);
    log(`env: ipv4_interface=${ifaces.some((i) => i.family === 'IPv4')} ipv6_interface=${ifaces.some((i) => i.family === 'IPv6')} auto_select_family=${typeof net.getDefaultAutoSelectFamily === 'function' ? net.getDefaultAutoSelectFamily() : 'n/a'} dns_order=${typeof dns.getDefaultResultOrder === 'function' ? dns.getDefaultResultOrder() : 'n/a'}`);
    log(`env: dns_resolvers=${resolvers.length} classes=${summarizeClasses(resolvers)} proxy_variables_set=${PROXY_VARS.filter((n) => o.has(n)).join(',') || 'none'}`);

    // Everything below starts at once, so even if several steps time out the total stays well inside the watchdog:
    // DNS (3 lookups), the default connect, and the two controls run together. Per-address TCP follows the DNS answer.
    // (None of these promises can reject: each one reports its own failure as data.)
    const controls = o.controls ?? [
      { role: 'sameHost443', label: 'same-host:443', host, port: 443, dnsFirst: false },
      { role: 'otherHost443', label: 'other-https-host:443', host: 'api.anthropic.com', port: 443, dnsFirst: true },
    ];
    const timed = async (fn) => {
      const t0 = Date.now();
      try { return { ok: true, ms: Date.now() - t0, value: await withTimeout(fn(), stepMs), t0 }; } catch (e) { return { ok: false, ms: Date.now() - t0, codes: errCodes(e) }; }
    };
    const connectionsP = Promise.all([
      (async () => { const r = await connectSocket({ host, port }, stepMs); if (r.socket) r.socket.destroy(); return r; })(),
      ...controls.map(async (c) => {
        const t0 = Date.now();
        let dnsText = '';
        if (c.dnsFirst) {
          const d = await timed(() => o.dns.lookup(c.host, { all: true }));
          if (!d.ok) return { ...c, ok: false, ms: Date.now() - t0, codes: d.codes, sys: '-', dnsText: 'dns=FAIL ' };
          dnsText = `dns=OK(${d.value.length}) `;
        }
        const r = await connectSocket({ host: c.host, port: c.port }, stepMs);
        if (r.socket) r.socket.destroy();
        return { ...c, ...r, dnsText };
      }),
    ]);

    // 1. DNS (three lookups together: libc getaddrinfo, and the resolver's A and AAAA records)
    const f = { dnsOk: false, tcpAny: false, dnsSuspicious: false };
    const [look, r4, r6] = await Promise.all([timed(() => o.dns.lookup(host, { all: true })), timed(() => o.dns.resolve4(host)), timed(() => o.dns.resolve6(host))]);
    let addrs = [];
    if (look.ok) {
      addrs = look.value.slice(0, MAX_ADDRESSES);
      f.dnsOk = addrs.length > 0;
      log(`dns.lookup: OK ms=${look.ms} addresses=${addrs.length} ipv4=${addrs.filter((a) => a.family === 4).length} ipv6=${addrs.filter((a) => a.family === 6).length} classes=${summarizeClasses(addrs.map((a) => a.address))}`);
      f.dnsSuspicious = addrs.length > 0 && addrs.every((a) => ['loopback', 'private', 'unspecified', 'link-local'].includes(classifyIp(a.address)));
    } else {
      log(`dns.lookup: FAIL ms=${look.ms} codes=${look.codes}`);
    }
    for (const [name, r] of [['dns.resolve4', r4], ['dns.resolve6', r6]]) {
      log(r.ok ? `${name}: OK ms=${r.ms} count=${r.value.length} classes=${summarizeClasses(r.value)}` : `${name}: FAIL ms=${r.ms} codes=${r.codes}`);
    }

    // 2-4. TCP to every resolved address, then the default connect and the controls (already running)
    const perAddress = f.dnsOk
      ? await Promise.all(addrs.map(async (a) => {
          const r = await connectSocket({ host: a.address, port, family: a.family }, stepMs);
          if (r.socket) r.socket.destroy();
          return { ...r, ip: a.address, family: a.family };
        }))
      : [];
    const [hyper, ...ctl] = await connectionsP;
    perAddress.forEach((r, i) => {
      f.tcpAny = f.tcpAny || r.ok;
      log(`tcp[#${i + 1} ipv${r.family} ${classifyIp(r.ip)}] port ${port}: ${okOrFail(r)} ms=${r.ms}${r.ok ? '' : ` ${failDetail(r)}`}`);
    });
    log(`tcp[node default connect, family auto-select] port ${port}: ${okOrFail(hyper)} ms=${hyper.ms}${hyper.ok ? ` family=ipv${hyper.family}` : ` ${failDetail(hyper)}`}`);
    f.hyperOk = hyper.ok;
    for (const c of ctl) log(`control[${c.label}]: ${c.dnsText || ''}tcp ${okOrFail(c)} ms=${c.ms}${c.ok ? '' : ` ${failDetail(c)}`}`);
    f.sameHostOk = !!(ctl.find((c) => c.role === 'sameHost443') || {}).ok;
    f.otherHostOk = !!(ctl.find((c) => c.role === 'otherHost443') || {}).ok;
    const families = new Set(perAddress.filter((r) => r.ok).map((r) => r.family));
    const failedFamilies = new Set(perAddress.filter((r) => !r.ok).map((r) => r.family));

    // 5. PostgreSQL SSLRequest + TLS handshake (verification ON)
    const good = perAddress.find((r) => r.ok);
    f.tls = null;
    if (!good && !hyper.ok) {
      log('tls.primary: SKIPPED (no TCP connection to the database port succeeded)');
    } else {
      const target = good ? { ip: good.ip, family: good.family } : null;
      const r = await pgTlsHandshake({ target, host, port, stepMs, verify: true, ca: o.tlsCa });
      f.tls = r;
      if (r.ok) log(`tls.primary(verify=on, sni=yes): OK ms=${r.ms} protocol=${r.protocol} cipher=${r.cipher} authorized=${r.authorized} issuer_org="${r.issuerOrg}" valid_to="${r.validTo}"`);
      else log(`tls.primary(verify=on, sni=yes): FAIL stage=${r.stage} ${r.answer ? `server_answer=${r.answer} ` : ''}codes=${r.codes} ms=${r.ms}`);
      if (!r.ok && r.stage === 'tls' && isCertClass(r.codes)) {
        const u = await pgTlsHandshake({ target, host, port, stepMs, verify: false, ca: o.tlsCa });
        f.tlsUnverified = u;
        log(`tls.followup(verify=OFF, diagnostic only, handshake then close): ${u.ok ? `OK ms=${u.ms} protocol=${u.protocol} certificate_error=${u.authError}` : `FAIL stage=${u.stage} codes=${u.codes}`}`);
      }
    }

    // 6. plain-language reading
    f.families = [...families];
    f.failedFamilies = [...failedFamilies];
    for (const v of buildVerdicts(f)) log(`verdict: ${v}`);
    log('done');
  } catch (e) {
    log(`unexpected error (class ${safeName(e)}); the diagnostic stopped`);
  }
  finish();
}

// ---------- the supervisor ----------
const safeSignal = (v) => (typeof v === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(v) ? v : 'UNKNOWN');
const safeInt = (v) => (Number.isInteger(v) && v >= 0 && v < 256 ? v : -1);

/**
 * Runs the probe process and guarantees: a hard deadline, no orphan, and exit 0 in EVERY case (the application must start).
 * o: { exec, args, env, deadlineMs, graceMs, killWaitMs, maxLines, host, log, exit, onSpawn }
 */
function runSupervisor(o) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve) => {
    if (o.host) secretHost = o.host;
    const maxLines = o.maxLines ?? MAX_RELAY_LINES;
    let child;
    let childGone = false;
    let sentinelSeen = false;
    let finishing = false;
    let ended = false;
    let relayed = 0;
    let truncated = false;
    let buffer = '';
    let deadlineTimer;
    let graceTimer;
    let killWaitTimer;
    const say = (text) => { if (!ended) o.log('[net-probe] ' + redact(text)); };
    const killChild = () => { if (child && !childGone) { try { child.kill('SIGKILL'); } catch { /* already gone */ } } };
    const onProcessExit = () => killChild(); // never leave the probe running behind us
    const signalHandlers = [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]].map(([sig, num]) => {
      const h = () => { killChild(); process.exit(128 + num); }; // an outside request to stop: stop the probe too, then follow it
      process.once(sig, h);
      return [sig, h];
    });
    process.once('exit', onProcessExit);
    const cleanup = () => {
      process.removeListener('exit', onProcessExit);
      for (const [sig, h] of signalHandlers) process.removeListener(sig, h);
    };
    const finish = () => {
      if (finishing) return;
      finishing = true;
      clearTimeout(deadlineTimer);
      clearTimeout(graceTimer);
      const done = () => {
        if (ended) return;
        ended = true;
        clearTimeout(killWaitTimer);
        cleanup();
        o.exit(0); // always 0: the diagnostic must never stop the application from starting
        resolve();
      };
      killChild();
      if (child && !childGone) {
        child.once('exit', done);
        killWaitTimer = setTimeout(done, o.killWaitMs); // do not wait indefinitely for the process to disappear
      } else {
        done();
      }
    };
    const relay = (line) => {
      if (line === SENTINEL) {
        if (!sentinelSeen) {
          sentinelSeen = true;
          graceTimer = setTimeout(() => { say('the diagnostic process was still shutting down after its report and was stopped'); finish(); }, o.graceMs);
        }
        return;
      }
      if (!line.startsWith('[net-probe] ')) return; // anything else the child wrote (stack traces, raw errors) is dropped
      if (relayed >= maxLines) { if (!truncated) { truncated = true; say('output limit reached; further lines were dropped'); } return; }
      relayed += 1;
      if (!ended) o.log(redact(line));
    };

    try {
      child = spawn(o.exec, o.args, { env: o.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      say(`could not start the diagnostic process (code ${safeCode(e && e.code)}); the application start is not affected`);
      finish();
      return;
    }
    child.on('error', (e) => { // start-up failure (for example the executable is missing or not allowed to run)
      childGone = true;
      say(`could not start the diagnostic process (code ${safeCode(e && e.code)}); the application start is not affected`);
      finish();
    });
    if (child.pid !== undefined && o.onSpawn) o.onSpawn(child.pid);
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 65536) buffer = buffer.slice(-65536);
      const parts = buffer.split('\n');
      buffer = parts.pop();
      for (const line of parts) relay(line.replace(/\r$/, ''));
    });
    child.stderr.on('data', () => {}); // consumed and dropped: raw error text is never shown
    child.on('exit', () => { childGone = true; });
    child.on('close', (code, signal) => {
      childGone = true;
      if (buffer) relay(buffer.replace(/\r$/, ''));
      if (!finishing && !sentinelSeen) {
        if (signal) say(`the diagnostic process ended unexpectedly (signal ${safeSignal(signal)})`);
        else if (code !== 0) say(`the diagnostic process ended unexpectedly (exit code ${safeInt(code)})`);
        else say('the diagnostic process ended without finishing its report');
      }
      finish();
    });
    deadlineTimer = setTimeout(() => {
      if (finishing) return;
      say(`deadline: the diagnostic did not finish within ${o.deadlineMs / 1000}s and was stopped; the lines above are partial`);
      finish();
    }, o.deadlineMs);
  });
}

const flushThenExit = (code) => { process.stdout.write('', () => process.exit(code)); setTimeout(() => process.exit(code), 500).unref(); };

/** What `prestart` runs. */
function supervisorMain() {
  const pre = precheck(envGet);
  if (!pre.run) { console.log('[net-probe] ' + pre.message); return flushThenExit(0); }
  const proxyNames = PROXY_VARS.filter((n) => envHas(n)); // names only, passed as an argument: proxy URLs can contain credentials
  return runSupervisor({
    exec: process.execPath,
    args: [__filename, '--child', `--proxy=${proxyNames.join(',')}`],
    env: buildChildEnv(envGet),
    deadlineMs: HARD_DEADLINE_MS,
    graceMs: GRACE_MS,
    killWaitMs: KILL_WAIT_MS,
    host: pre.host,
    log: (line) => console.log(line),
    exit: flushThenExit,
  });
}

/** The probe process (`--child`): the real checks. It ends its report with the SENTINEL line. */
function childDeps(argv) {
  const proxy = (argv.find((a) => a.startsWith('--proxy=')) || '').slice('--proxy='.length).split(',');
  return {
    get: envGet,
    has: (n) => PROXY_VARS.includes(n) && proxy.includes(n),
    log: (line) => console.log(line),
    exit: (code) => { process.stdout.write(`${SENTINEL}\n`, () => process.exit(code)); setTimeout(() => process.exit(code), 500).unref(); },
    dns: { lookup: (h, opt) => dns.promises.lookup(h, opt), resolve4: (h) => dns.promises.resolve4(h), resolve6: (h) => dns.promises.resolve6(h) },
    stepMs: STEP_MS,
    totalMs: CHILD_BUDGET_MS,
    marker: MARKER,
  };
}

// ===================================== self-test (loopback only, no external network) =====================================
async function selfTest() {
  const crypto = require('node:crypto');
  const { spawn } = require('node:child_process'); // self-test only: runs the real script in a separate process
  const checks = [];
  const notes = [];
  const check = (name, pass, detail) => checks.push([name, !!pass, detail]);
  // Durations use the monotonic clock, which a manual clock change or NTP adjustment cannot distort. It does NOT protect against
  // system sleep: on macOS Node's hrtime keeps counting while the machine is suspended (found the hard way, see `robust`).
  const mono = () => Number(process.hrtime.bigint()) / 1e6;
  /**
   * Runs a timing-sensitive attempt. An overshoot of more than 5x its bound is not "a slow test": the machine was almost
   * certainly suspended mid-run (a laptop sleeping showed a 288 s duration for a 400 ms step), so the attempt is repeated once and
   * the event is reported as a NOTE. A real regression fails again on the repeat, so it is never hidden.
   */
  const robust = async (name, bound, attempt) => {
    let res = await attempt();
    if (!res.ok && res.ms > bound * 5) {
      notes.push(`"${name}": the first attempt took ${res.ms.toFixed(0)} ms against a bound of ${bound} ms, so the machine was probably suspended (sleep); the attempt was repeated`);
      res = await attempt();
    }
    return res;
  };
  /** Records the longest event-loop gap (a blocked or starved loop shows up here). */
  const gapMonitor = () => {
    let last = mono();
    let max = 0;
    const h = setInterval(() => { const n = mono(); max = Math.max(max, n - last - 10); last = n; }, 10);
    return { stop: () => { clearInterval(h); return max; } };
  };

  // Network guard: any connection or lookup that is not loopback fails the self-test, and DNS is answered locally.
  const touched = [];
  const isLocal = (h) => ['localhost', '127.0.0.1', '::1', undefined].includes(h);
  const realConnect = net.connect;
  net.connect = (options, ...rest) => {
    touched.push(`connect:${options && options.host}`);
    if (!isLocal(options && options.host)) throw Object.assign(new Error('blocked by the self-test network guard'), { code: 'SELFTEST_BLOCKED' });
    return realConnect(options.host === 'localhost' ? { ...options, host: '127.0.0.1', family: undefined } : options, ...rest);
  };
  const localDns = {
    lookup: async (h) => { touched.push(`lookup:${h}`); if (!isLocal(h)) throw new Error('blocked'); return [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]; },
    resolve4: async (h) => { touched.push(`resolve4:${h}`); if (!isLocal(h)) throw new Error('blocked'); return ['127.0.0.1']; },
    resolve6: async (h) => { touched.push(`resolve6:${h}`); if (!isLocal(h)) throw new Error('blocked'); throw Object.assign(new Error('no data'), { code: 'ENODATA' }); },
  };

  // --- a throwaway self-signed certificate for "localhost", built in memory with node:crypto (no key or certificate is stored anywhere)
  const tlv = (tag, ...parts) => {
    const body = Buffer.concat(parts);
    const n = body.length;
    const len = n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
    return Buffer.concat([Buffer.from([tag]), len, body]);
  };
  const oid = (bytes) => tlv(0x06, Buffer.from(bytes));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const algId = tlv(0x30, oid([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b]), Buffer.from([0x05, 0x00]));
  const name = tlv(0x30, tlv(0x31, tlv(0x30, oid([0x55, 0x04, 0x03]), tlv(0x0c, Buffer.from('localhost')))));
  const exts = tlv(0xa3, tlv(0x30,
    tlv(0x30, oid([0x55, 0x1d, 0x13]), tlv(0x01, Buffer.from([0xff])), tlv(0x04, tlv(0x30, tlv(0x01, Buffer.from([0xff]))))),
    tlv(0x30, oid([0x55, 0x1d, 0x11]), tlv(0x04, tlv(0x30, tlv(0x82, Buffer.from('localhost')))))));
  const tbs = tlv(0x30, tlv(0xa0, tlv(0x02, Buffer.from([0x02]))), tlv(0x02, Buffer.from([0x01])), algId, name,
    tlv(0x30, tlv(0x17, Buffer.from('240101000000Z')), tlv(0x17, Buffer.from('491231235959Z'))), name,
    publicKey.export({ type: 'spki', format: 'der' }), exts);
  const sig = crypto.sign('sha256', tbs, privateKey);
  const der = tlv(0x30, tbs, algId, tlv(0x03, Buffer.concat([Buffer.from([0x00]), sig])));
  const certPem = new crypto.X509Certificate(der).toString();
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  // --- a fake PostgreSQL port: records exactly what the probe sends
  const servers = [];
  const fakePg = ({ mode }) => new Promise((resolve) => {
    const seen = { plain: [], tlsData: 0, handshakes: 0 };
    // After "S" the raw socket is handed to a TLS server, exactly as PostgreSQL does.
    const tlsServer = tls.createServer({ key: keyPem, cert: certPem }, (ts) => {
      seen.handshakes += 1;
      ts.on('error', () => {});
      ts.on('data', () => { seen.tlsData += 1; });
    });
    tlsServer.on('tlsClientError', () => {});
    const server = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.once('data', (d) => {
        seen.plain.push(d);
        if (mode === 'silent') return;
        if (mode === 'N') return sock.end(Buffer.from('N'));
        if (mode === 'garbage') return sock.end(Buffer.from('X'));
        sock.write('S');
        tlsServer.emit('connection', sock);
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen }));
  });
  const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

  const base = (extra) => {
    const lines = [];
    let exitCode;
    let exits = 0;
    const env = { [GUARD_VAR]: GUARD_VALUE, [HOST_VAR]: 'localhost', ...extra.env };
    return {
      lines,
      exitInfo: () => ({ exitCode, exits }),
      opts: { get: (n) => env[n], has: () => false, log: (l) => lines.push(l), exit: (c) => { exits += 1; exitCode = c; }, dns: localDns, stepMs: 600, totalMs: 6000, marker: null, controls: [], ...extra.opts },
    };
  };
  const text = (lines) => lines.join('\n');
  const ctlOpen = await fakePg({ mode: 'silent' });
  const controlsLocal = [{ role: 'sameHost443', label: 'same-host:443', host: 'localhost', port: ctlOpen.port, dnsFirst: false }, { role: 'otherHost443', label: 'other-https-host:443', host: 'localhost', port: ctlOpen.port, dnsFirst: true }];

  // 1. redaction
  secretHost = 'ep-demo-1234.c-7.eu-central-1.aws.neon.tech';
  const dirty = `host EP-DEMO-1234.C-7.EU-CENTRAL-1.AWS.NEON.TECH and 18.196.1.2 and 2001:db8::1 and ::1 and a.b.example.org plus 3.0.15`;
  const clean = redact(dirty);
  check('redaction removes the host (any case), IPv4, IPv6 and other dotted names, but keeps plain text', !/ep-demo|neon|18\.196|2001:|::1|example\.org/i.test(clean) && clean.includes('3.0.15'), clean);
  secretHost = 'dbhost-demo';
  const single = redact('could not reach DBHOST-DEMO or dbhost-demo:5432');
  check('redaction also removes a single-label host name (exact match, any case), which no generic pattern would catch', !/dbhost/i.test(single) && single.includes('<host>'), single);
  secretHost = '';

  // 2. protocol bytes
  check('the only thing sent to the database port is the 8-byte SSLRequest (length 8, code 80877103)', SSL_REQUEST.equals(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])) && SSL_REQUEST.readInt32BE(4) === 80877103);

  // 3. address classes
  const expectClass = { '127.0.0.1': 'loopback', '10.1.2.3': 'private', '172.20.0.1': 'private', '192.168.1.1': 'private', '100.64.0.1': 'cgnat', '169.254.1.1': 'link-local', '0.0.0.0': 'unspecified', '8.8.8.8': 'public', '::1': 'loopback', 'fe80::1': 'link-local', 'fd00::1': 'private', '::': 'unspecified', '::ffff:10.0.0.1': 'ipv4-mapped', '2606:4700::1': 'public' };
  const badClass = Object.entries(expectClass).filter(([ip, c]) => classifyIp(ip) !== c);
  check('address classification (loopback/private/cgnat/link-local/unspecified/mapped/public)', badClass.length === 0, JSON.stringify(badClass));

  // 4. guard and input validation: nothing happens, exit 0, no network
  const calls0 = touched.length;
  let r = base({ env: { [GUARD_VAR]: undefined } });
  await runProbe(r.opts);
  check('inactive without GHARSE_NET_PROBE=ONCE: one line, exit 0, no network', r.lines.length === 1 && /inactive/.test(r.lines[0]) && r.exitInfo().exitCode === 0 && touched.length === calls0);
  r = base({ env: { [GUARD_VAR]: 'YES' } });
  await runProbe(r.opts);
  check('inactive for any value other than ONCE', /inactive/.test(r.lines[0]) && r.exitInfo().exitCode === 0 && touched.length === calls0);
  for (const bad of ['', 'postgresql://user:secret@host.example.test/db', 'a b', 'host/../x', 'user:pw@host.example.test', 'x']) {
    r = base({ env: { [HOST_VAR]: bad } });
    await runProbe(r.opts);
    check(`invalid host value is refused and never echoed: ${JSON.stringify(bad).slice(0, 24)}`, /not run/.test(r.lines[0]) && !text(r.lines).includes('secret') && !(bad.length > 2 && text(r.lines).includes(bad)) && r.exitInfo().exitCode === 0 && touched.length === calls0);
  }

  // 5. full local run, verified TLS against our own CA
  const allLines = [];
  const pgOk = await fakePg({ mode: 'S' });
  r = base({ env: { [PORT_VAR]: String(pgOk.port) }, opts: { tlsCa: certPem, controls: controlsLocal } });
  await runProbe(r.opts);
  allLines.push(...r.lines);
  let t = text(r.lines);
  check('verified TLS handshake succeeds (verify=on, SNI) and the verdict says the network path is fine', /tls\.primary\(verify=on, sni=yes\): OK/.test(t) && /authorized=true/.test(t) && /network path to the database is fine/.test(t), t.slice(-400));
  check('DNS, per-address TCP (IPv4 and IPv6) and both controls are reported', /dns\.lookup: OK/.test(t) && /dns\.resolve4: OK/.test(t) && /dns\.resolve6: FAIL .*ENODATA/.test(t) && /tcp\[#1 ipv4 loopback\] port \d+: OK/.test(t) && /tcp\[#2 ipv6 loopback\]/.test(t) && /control\[same-host:443\]: tcp OK/.test(t) && /control\[other-https-host:443\]: dns=OK\(2\) tcp OK/.test(t));
  check('it exits 0 exactly once and ends with "done"', r.exitInfo().exitCode === 0 && r.exitInfo().exits === 1 && /done$/.test(r.lines[r.lines.length - 1]));
  await new Promise((res) => setTimeout(res, 150));
  const sentPlain = Buffer.concat(pgOk.seen.plain);
  check('it sent exactly the 8-byte SSLRequest in plain text, and nothing at all after the TLS handshake', sentPlain.equals(SSL_REQUEST) && pgOk.seen.tlsData === 0 && pgOk.seen.handshakes >= 1, `plain=${sentPlain.length} bytes, tls data events=${pgOk.seen.tlsData}`);

  // 6. certificate verification really is on: the same server without our CA is NOT trusted
  const pgSelf = await fakePg({ mode: 'S' });
  r = base({ env: { [PORT_VAR]: String(pgSelf.port) }, opts: { controls: [] } });
  await runProbe(r.opts);
  allLines.push(...r.lines);
  t = text(r.lines);
  check('with verification on, an untrusted certificate is rejected (primary FAIL with a certificate code)', /tls\.primary\(verify=on, sni=yes\): FAIL stage=tls .*codes=(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/.test(t), t.slice(-500));
  check('the labelled verify=OFF follow-up then succeeds and the verdict names a CA-store or clock problem', /tls\.followup\(verify=OFF, diagnostic only.*OK/.test(t) && /certificate verification fails/.test(t));

  // 7. server answers N, answers garbage, stays silent
  const pgN = await fakePg({ mode: 'N' });
  r = base({ env: { [PORT_VAR]: String(pgN.port) } });
  await runProbe(r.opts);
  allLines.push(...r.lines);
  check('a server that declines TLS ("N") is reported as such', /server_answer=N/.test(text(r.lines)) && /declined TLS/.test(text(r.lines)));
  const pgG = await fakePg({ mode: 'garbage' });
  r = base({ env: { [PORT_VAR]: String(pgG.port) } });
  await runProbe(r.opts);
  allLines.push(...r.lines);
  check('an unexpected answer byte is reported without being printed', /server_answer=UNEXPECTED/.test(text(r.lines)) && !/\bX\b/.test(text(r.lines.filter((l) => /server_answer/.test(l)))));
  const pgSilent = await fakePg({ mode: 'silent' });
  const silentName = 'a silent server times out at the step limit (TIMEOUT) and the run still finishes with exit 0';
  const silent = await robust(silentName, 3000, async () => {
    const t0 = mono();
    const rr = base({ env: { [PORT_VAR]: String(pgSilent.port) } });
    await runProbe(rr.opts);
    allLines.push(...rr.lines);
    const ms = mono() - t0;
    return { ok: /stage=sslrequest codes=TIMEOUT/.test(text(rr.lines)) && ms < 3000 && rr.exitInfo().exitCode === 0, ms, detail: `${ms.toFixed(0)} ms` };
  });
  check(silentName, silent.ok, silent.detail);

  // 8. connection refused
  const closed = await freePort();
  r = base({ env: { [PORT_VAR]: String(closed) }, opts: { controls: controlsLocal } });
  await runProbe(r.opts);
  allLines.push(...r.lines);
  t = text(r.lines);
  check('a refused connection is reported as ECONNREFUSED (never a raw message), TLS is skipped, and a verdict is given', /port \d+: FAIL ms=\d+ codes=ECONNREFUSED syscall=connect/.test(t) && /tls\.primary: SKIPPED/.test(t) && /verdict: /.test(t) && !/connect ECONNREFUSED/.test(t), t.slice(-600));

  // 8b. every verdict branch, on synthetic facts (pure function)
  const V = (facts) => buildVerdicts({ dnsOk: true, tcpAny: false, hyperOk: false, dnsSuspicious: false, sameHostOk: false, otherHostOk: false, tls: null, tlsUnverified: null, families: [], failedFamilies: [], ...facts }).join(' | ');
  const goodTls = { ok: true, authorized: true };
  const verdictCases = [
    ['DNS fails', { dnsOk: false }, /resolver is blocked/],
    ['DNS filtered (loopback/private answers, no TCP)', { dnsSuspicious: true }, /filtered or hijacked/],
    ['5432 blocked while 443 to the same host works', { sameHostOk: true }, /outbound 5432 is blocked/],
    ['host-specific block (other HTTPS host works)', { otherHostOk: true }, /host- or address-specific/],
    ['nothing connects at all', {}, /general outbound access is blocked/],
    ['everything works', { tcpAny: true, hyperOk: true, tls: goodTls }, /network path to the database is fine/],
    ['server declines TLS', { tcpAny: true, hyperOk: true, tls: { ok: false, stage: 'sslrequest', answer: 'N' } }, /declined TLS/],
    ['server gives no answer to the TLS request', { tcpAny: true, hyperOk: true, tls: { ok: false, stage: 'sslrequest', codes: 'TIMEOUT' } }, /did not answer the TLS request properly \(TIMEOUT\)/],
    ['certificate verification fails but the unverified handshake works', { tcpAny: true, hyperOk: true, tls: { ok: false, stage: 'tls', codes: 'CERT_HAS_EXPIRED' }, tlsUnverified: { ok: true } }, /CA-store or clock problem/],
    ['TLS fails for another reason', { tcpAny: true, hyperOk: true, tls: { ok: false, stage: 'tls', codes: 'ECONNRESET' } }, /TLS step fails \(tls, ECONNRESET\)/],
    ['only one address family connects', { tcpAny: true, hyperOk: true, tls: goodTls, families: [4], failedFamilies: [6] }, /Only IPv4 addresses connect/],
    ['addresses connect but the default connect does not', { tcpAny: true, hyperOk: false, tls: goodTls, families: [4], failedFamilies: [] }, /default connect does not/],
  ];
  for (const [label, facts, re] of verdictCases) check(`verdict: ${label}`, re.test(V(facts)), V(facts));

  // 9. watchdog
  const wdName = 'the watchdog stops a stuck run on time (monotonic clock), says the output is partial, exits 0 once, and the event loop is never blocked';
  const wdRes = await robust(wdName, 1500, async () => {
    const wd = base({ env: { [PORT_VAR]: String(pgSilent.port) }, opts: { totalMs: 250, stepMs: 5000 } });
    const gap = gapMonitor();
    const t0 = mono();
    const wall0 = Date.now();
    await new Promise((resolve) => { wd.opts.exit = (c) => { wd.exitCode = c; wd.exits = (wd.exits || 0) + 1; resolve(); }; runProbe(wd.opts); });
    const ms = mono() - t0;
    const wallMs = Date.now() - wall0;
    const maxGap = gap.stop();
    allLines.push(...wd.lines);
    if (Math.abs(wallMs - ms) > 1000) notes.push(`the wall clock moved ${wallMs} ms while the monotonic clock moved ${ms.toFixed(0)} ms during the watchdog check: the system clock was changed`);
    return { ok: ms >= 200 && ms < 1500 && /watchdog/.test(text(wd.lines)) && wd.exitCode === 0 && wd.exits === 1 && maxGap < 500, ms, detail: `${ms.toFixed(0)} ms monotonic, ${wallMs} ms wall clock, longest event-loop gap ${maxGap.toFixed(0)} ms` };
  });
  check(wdName, wdRes.ok, wdRes.detail);

  // 9a. SUPERVISOR lifecycle, with REAL subprocesses. The supervisor runs in its own process, so its real exit code and lifetime are
  // observed, and it supervises scripted fake probe processes. After every run the fake process's pid is checked: it must be gone.
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const isGone = async (pid) => { for (let i = 0; i < 80; i++) { if (!isAlive(pid)) return true; await sleep(25); } return false; };
  const SQ = JSON.stringify(SENTINEL);
  const POOL = `require('node:crypto').pbkdf2('x', 'y', 2147483647, 64, 'sha512', () => {});`; // a stuck thread-pool job, like a hung getaddrinfo
  const fakes = {
    normal: `console.log('[net-probe] hello from the probe'); console.log(${SQ});`,
    exit7: `console.log('[net-probe] partial report'); process.exit(7);`,
    crash: `console.log('[net-probe] partial report'); process.kill(process.pid, 'SIGKILL');`,
    hang: `console.log('[net-probe] started'); setInterval(() => {}, 1000);`,
    poolAfterReport: `${POOL} console.log('[net-probe] full report'); console.log(${SQ}); setTimeout(() => process.exit(0), 100);`,
    poolNoReport: `${POOL} console.log('[net-probe] started'); setInterval(() => {}, 1000);`,
    noisy: `console.log('[net-probe] reached db-secret-host.example.test at 203.0.113.9'); console.log('Error: connect ECONNREFUSED 10.0.0.1:5432'); console.log('    at Object.<anonymous> (/app/x.js:1:1)'); console.error('secret stderr line'); console.log(${SQ});`,
    flood: `for (let i = 0; i < 5000; i++) console.log('[net-probe] line ' + i); console.log(${SQ});`,
    envReport: `console.log('[net-probe] ENVKEYS=' + Object.keys(process.env).sort().join(',')); console.log('[net-probe] SECRETCOUNT=' + Object.values(process.env).filter((v) => /SUPERSECRET/.test(v)).length); console.log(${SQ});`,
  };
  const supHarness = [
    `const p = require(${JSON.stringify(__filename)});`,
    `const cfg = JSON.parse(process.argv[1]);`,
    `const quit = (c) => process.stdout.write('', () => process.exit(c));`,
    `p.runSupervisor({ exec: cfg.exec || process.execPath, args: cfg.args, env: p.buildChildEnv(p.envGet), deadlineMs: cfg.deadlineMs, graceMs: cfg.graceMs, killWaitMs: 1000, maxLines: cfg.maxLines, host: cfg.host, log: (l) => console.log(l), exit: quit, onSpawn: (pid) => console.log('PID=' + pid) });`,
  ].join('\n');
  /** Runs the supervisor (or any command) as a real process and reports its real exit code, lifetime, output and whether its child is gone. */
  const runProc = (argv, { env = {}, killAfterMs = 12000, termOnPid = false } = {}) => new Promise((resolve) => {
    const startedAt = mono();
    const proc = spawn(process.execPath, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let killed = false;
    let termSent = false;
    proc.stdout.on('data', (d) => { out += d; if (termOnPid && !termSent && /PID=\d+/.test(out)) { termSent = true; proc.kill('SIGTERM'); } });
    proc.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { killed = true; proc.kill('SIGKILL'); }, killAfterMs);
    proc.on('close', async (code, signal) => {
      clearTimeout(timer);
      const ms = mono() - startedAt;
      const m = /PID=(\d+)/.exec(out);
      const pid = m ? Number(m[1]) : null;
      const lines = out.split('\n').filter(Boolean);
      resolve({ code, signal, killed, ms, out, lines, shown: lines.filter((l) => !l.startsWith('PID=')), pid, gone: pid === null ? true : await isGone(pid) });
    });
  });
  const DEADLINE = 700;
  const GRACE = 400;
  const BOUND = 2500; // generous room for node start-up on a slow machine
  const tail = (r) => `exit=${r.code} signal=${r.signal} killed=${r.killed} ${r.ms.toFixed(0)} ms, child gone=${r.gone}; output: ${JSON.stringify(r.shown.slice(-3))}`.slice(0, 400);
  const sup = (name, bound, cfg, opts, expectCode, pass) => ({ name, bound, cfg, opts, expectCode, pass });
  const SECRETS_ENV = { GHARSE_NET_PROBE: 'ONCE', GHARSE_NET_PROBE_HOST: 'db.example.test', GHARSE_NET_PROBE_PORT: '5432', TMPDIR: '/tmp', DATABASE_URL: 'postgresql://u:SUPERSECRETPW@h.example.test/db', ANTHROPIC_API_KEY: 'SUPERSECRETKEY', SMTP_PASS: 'SUPERSECRETSMTP', NODE_OPTIONS: '--max-old-space-size=64', HTTPS_PROXY: 'http://user:SUPERSECRETPROXY@proxy.example.test:3128', PATH: '/usr/bin', HOME: '/root' };
  const scenarios = [
    sup('supervisor: normal completion - report relayed, no deadline or error line, exit 0, probe process gone', BOUND, { args: ['-e', fakes.normal], deadlineMs: 5000, graceMs: GRACE }, {}, 0,
      (r) => /hello from the probe/.test(r.out) && !/deadline|unexpectedly|could not start|shutting down/.test(r.out) && r.ms < BOUND),
    sup('supervisor: start-up failure (executable missing) - fixed message with the error code only, exit 0', BOUND, { exec: '/nonexistent/probe-node', args: [], deadlineMs: 5000, graceMs: GRACE }, {}, 0,
      (r) => /could not start the diagnostic process \(code ENOENT\)/.test(r.out) && r.pid === null && !/nonexistent/.test(r.out)),
    sup('supervisor: unexpected probe exit (non-zero code) is reported by code, exit 0', BOUND, { args: ['-e', fakes.exit7], deadlineMs: 5000, graceMs: GRACE }, {}, 0,
      (r) => /ended unexpectedly \(exit code 7\)/.test(r.out) && /partial report/.test(r.out)),
    sup('supervisor: probe killed by a signal is reported by signal name, exit 0', BOUND, { args: ['-e', fakes.crash], deadlineMs: 5000, graceMs: GRACE }, {}, 0,
      (r) => /ended unexpectedly \(signal SIGKILL\)/.test(r.out)),
    sup('supervisor: a probe that hangs forever is killed AT THE DEADLINE; exit 0, not early, not late, probe process gone', DEADLINE + BOUND, { args: ['-e', fakes.hang], deadlineMs: DEADLINE, graceMs: GRACE }, {}, 0,
      (r) => /deadline: the diagnostic did not finish within 0\.7s/.test(r.out) && r.ms >= DEADLINE && r.ms < DEADLINE + BOUND),
    sup('supervisor: a probe with a STALLED THREAD-POOL job that finished its report is stopped after the grace period (process.exit would have waited for the job); exit 0', GRACE + BOUND, { args: ['-e', fakes.poolAfterReport], deadlineMs: 10000, graceMs: GRACE }, {}, 0,
      (r) => /full report/.test(r.out) && /still shutting down after its report and was stopped/.test(r.out) && !/deadline/.test(r.out) && r.ms < GRACE + BOUND),
    sup('supervisor: a probe with a stalled thread-pool job that never finishes is killed at the deadline; exit 0, probe process gone', DEADLINE + BOUND, { args: ['-e', fakes.poolNoReport], deadlineMs: DEADLINE, graceMs: GRACE }, {}, 0,
      (r) => /deadline: the diagnostic did not finish/.test(r.out) && r.ms >= DEADLINE && r.ms < DEADLINE + BOUND),
    sup('supervisor: probe output is filtered (only [net-probe] lines), redacted again (host and IPs), and stderr is dropped', BOUND, { args: ['-e', fakes.noisy], deadlineMs: 5000, graceMs: GRACE, host: 'db-secret-host.example.test' }, {}, 0,
      (r) => r.shown.length > 0 && r.shown.every((l) => l.startsWith('[net-probe] ')) && /<host>/.test(r.out) && /<ip>/.test(r.out) && !/db-secret-host|203\.0\.113\.9|ECONNREFUSED|at Object|secret stderr/.test(r.out)),
    sup('supervisor: a flood of probe output is capped, with one notice', BOUND, { args: ['-e', fakes.flood], deadlineMs: 5000, graceMs: GRACE, maxLines: 50 }, {}, 0,
      (r) => r.shown.length <= 51 && /output limit reached/.test(r.out)),
    sup('supervisor: the probe gets ONLY the allow-listed environment - DATABASE_URL, API keys, proxy credentials, NODE_OPTIONS, PATH and HOME never reach it', BOUND, { args: ['-e', fakes.envReport], deadlineMs: 5000, graceMs: GRACE }, { env: SECRETS_ENV }, 0,
      (r) => {
        const keys = ((/ENVKEYS=(\S*)/.exec(r.out) || [])[1] || '').split(',').filter(Boolean);
        const allowed = new Set(CHILD_ENV_NAMES);
        const extra = keys.filter((k) => !allowed.has(k) && !/^__CF/.test(k)); // macOS adds __CF_USER_TEXT_ENCODING to every process
        return extra.length === 0 && ['GHARSE_NET_PROBE', 'GHARSE_NET_PROBE_HOST', 'GHARSE_NET_PROBE_PORT', 'TMPDIR'].every((k) => keys.includes(k)) && /SECRETCOUNT=0/.test(r.out) && !/SUPERSECRET/.test(r.out);
      }),
    sup('supervisor: an outside SIGTERM stops the probe too (no orphan) and the supervisor follows it (exit 143)', BOUND, { args: ['-e', fakes.hang], deadlineMs: 30000, graceMs: GRACE }, { termOnPid: true }, 143,
      (r) => r.ms < BOUND),
  ];
  const scenarioResults = await Promise.all(scenarios.map((sc) => robust(sc.name, sc.bound, async () => {
    const r = await runProc(['-e', supHarness, JSON.stringify(sc.cfg)], sc.opts);
    sc.last = r;
    const ok = !r.killed && r.code === sc.expectCode && r.gone && !!sc.pass(r);
    return { ok, ms: r.ms, detail: tail(r) };
  })));
  scenarios.forEach((sc, i) => check(sc.name, scenarioResults[i].ok, scenarioResults[i].detail));
  const ranWithChild = scenarios.filter((sc) => sc.last && sc.last.pid !== null);
  check('every diagnostic failure case (start-up failure, unexpected exit, signal, hang, stalled thread pool, flood) leaves the supervisor exiting with code 0', scenarios.filter((sc) => sc.expectCode === 0).every((sc) => sc.last && sc.last.code === 0 && !sc.last.killed));
  check(`no probe process is left behind in any scenario (${ranWithChild.length} probe processes checked by pid)`, ranWithChild.length >= 9 && ranWithChild.every((sc) => sc.last.gone));

  // 9a-2. the real command line (nothing here reaches the network)
  const inactiveName = 'real command line, inactive (what every normal start does): one line, exit 0, no probe process started, effectively immediate';
  const cliInactive = await robust(inactiveName, 2500, async () => {
    const r = await runProc([__filename], {});
    return { ok: r.code === 0 && !r.killed && r.lines.length === 1 && /inactive/.test(r.out) && r.ms < 2500, ms: r.ms, detail: tail(r) };
  });
  check(inactiveName, cliInactive.ok, cliInactive.detail);
  const badHost = await runProc([__filename], { env: { GHARSE_NET_PROBE: 'ONCE', GHARSE_NET_PROBE_HOST: 'postgresql://user:SUPERSECRETPW@h.example.test/db' } });
  check('real command line with a pasted connection string as the host: refused, nothing echoed, no probe process, exit 0', badHost.code === 0 && badHost.lines.length === 1 && /not run/.test(badHost.out) && !/SUPERSECRET|postgresql/.test(badHost.out));
  const childAlone = await runProc([__filename, '--child'], {});
  check('the probe process itself (--child) ends its report with the end-of-report line and exits 0', childAlone.code === 0 && childAlone.lines[childAlone.lines.length - 1] === SENTINEL && /inactive/.test(childAlone.out));
  const e2eDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gharse-net-probe-e2e-'));
  const e2eMarker = path.join(e2eDir, 'gharse-net-probe.done');
  fs.writeFileSync(e2eMarker, 'x'); // the "already ran" marker, so the probe process stops before any DNS or network step
  const e2e = await runProc([__filename], { env: { GHARSE_NET_PROBE: 'ONCE', GHARSE_NET_PROBE_HOST: 'localhost', TMPDIR: e2eDir, DATABASE_URL: 'postgresql://u:SUPERSECRETPW@h.example.test/db' } });
  try { fs.unlinkSync(e2eMarker); fs.rmdirSync(e2eDir); } catch { /* ignore */ }
  check('real command line, end to end through the REAL probe process (marker present, so no network): TMPDIR reaches it, only [net-probe] lines, exit 0, no secret echoed',
    e2e.code === 0 && !e2e.killed && e2e.lines.length >= 1 && e2e.lines.every((l) => l.startsWith('[net-probe] ')) && /already ran in this container/.test(e2e.out) && !/start:|dns\./.test(e2e.out) && !/SUPERSECRET/.test(e2e.out) && e2e.ms < 2500, tail(e2e));
  check('pure helpers: buildChildEnv passes exactly the allow-list and drops everything else; precheck refuses before any child is started',
    (() => {
      const everything = (n) => `value-of-${n}`;
      const built = buildChildEnv((n) => (n === 'DATABASE_URL' || n === 'PATH' || CHILD_ENV_NAMES.includes(n) ? everything(n) : undefined));
      return JSON.stringify(Object.keys(built).sort()) === JSON.stringify([...CHILD_ENV_NAMES].sort()) && !('DATABASE_URL' in built) && !('PATH' in built)
        && !precheck(() => undefined).run && !precheck((n) => (n === GUARD_VAR ? 'ONCE' : 'a b')).run && precheck((n) => (n === GUARD_VAR ? 'ONCE' : 'db.example.test')).run;
    })());

  // 9b. the three DNS lookups run together (3 hanging lookups cost ONE step limit, not three) and the run still ends cleanly
  const hang = () => new Promise(() => {});
  const parName = 'three hanging DNS lookups cost one step limit (concurrent), are reported as TIMEOUT, and give the DNS verdict';
  const parRes = await robust(parName, 900, async () => {
    const par = base({ opts: { dns: { lookup: hang, resolve4: hang, resolve6: hang }, stepMs: 400 } });
    const t0 = mono();
    await runProbe(par.opts);
    const ms = mono() - t0;
    allLines.push(...par.lines);
    return { ok: ms < 900 && (text(par.lines).match(/FAIL ms=\d+ codes=TIMEOUT/g) || []).length === 3 && /resolver is blocked/.test(text(par.lines)) && par.exitInfo().exitCode === 0, ms, detail: `${ms.toFixed(0)} ms` };
  });
  check(parName, parRes.ok, parRes.detail);

  // 9c. a stray space or newline in an environment value (common in hosting panels) does not stop the run
  const ws = base({ env: { [GUARD_VAR]: 'ONCE\n', [HOST_VAR]: ' localhost ', [PORT_VAR]: String(closed) } });
  await runProbe(ws.opts);
  allLines.push(...ws.lines);
  check('values with stray whitespace or a trailing newline are trimmed and accepted', /start: port=/.test(text(ws.lines)) && !/inactive|not run/.test(text(ws.lines)) && ws.exitInfo().exitCode === 0);

  // 9d. the suspension tolerance itself: a big overshoot is repeated once and reported; a real failure still fails
  let simCalls = 0;
  const simSleep = await robust('simulated suspension', 100, async () => (++simCalls === 1 ? { ok: false, ms: 1000 } : { ok: true, ms: 10 }));
  const simNotes = notes.filter((n) => /simulated suspension/.test(n)).length;
  let regCalls = 0;
  const simRegression = await robust('simulated regression', 100, async () => { regCalls += 1; return { ok: false, ms: 1000 }; });
  let slowCalls = 0;
  const simSlow = await robust('simulated slow-but-failing check', 100, async () => { slowCalls += 1; return { ok: false, ms: 300 }; });
  check('suspension tolerance: an overshoot of more than 5x is repeated once and reported as a NOTE; a failure that repeats, or a modest overshoot, still fails',
    simSleep.ok && simCalls === 2 && simNotes === 1 && !simRegression.ok && regCalls === 2 && !simSlow.ok && slowCalls === 1, JSON.stringify({ simCalls, simNotes, regCalls, slowCalls }));
  for (let i = notes.length - 1; i >= 0; i--) if (/^"simulated /.test(notes[i])) notes.splice(i, 1); // these notes belong to the check above, not to the machine

  // 10. marker: runs once per container
  const marker = path.join(os.tmpdir(), `gharse-net-probe-selftest-${process.pid}.done`);
  r = base({ env: { [PORT_VAR]: String(closed) }, opts: { marker } });
  await runProbe(r.opts);
  const markerWritten = fs.existsSync(marker);
  const before = touched.length;
  const again = base({ env: { [PORT_VAR]: String(closed) }, opts: { marker } });
  await runProbe(again.opts);
  check('it runs once per container: the second run only says it already ran, with no network', markerWritten && /already ran/.test(text(again.lines)) && touched.length === before && again.exitInfo().exitCode === 0);
  try { fs.unlinkSync(marker); } catch { /* ignore */ }

  // 11. an unexpected internal failure still exits 0
  const boom = base({ opts: { has: () => { throw new TypeError('secret-looking detail'); } } });
  await runProbe(boom.opts);
  check('an unexpected internal error is reported by class only (no message) and the run still exits 0', boom.exitInfo().exitCode === 0 && /unexpected error \(class TypeError\)/.test(text(boom.lines)) && !/secret-looking/.test(text(boom.lines)), text(boom.lines).slice(-200));

  // 12. output safety across ALL runs above
  const everything = allLines.concat(r.lines).join('\n');
  check('every output line is prefixed [net-probe] and contains no host name, IP address, raw error message or stack', allLines.every((l) => l.startsWith('[net-probe] ')) && !/localhost|127\.0\.0\.1|::1\b|connect ECONN|Error:|\n\s+at /.test(everything), everything.match(/localhost|127\.0\.0\.1|::1\b|connect ECONN|Error:/) + '');

  // 13. the self-test itself reached nothing outside loopback
  const external = touched.filter((x) => !/^(connect|lookup|resolve4|resolve6):(localhost|127\.0\.0\.1|::1|undefined)$/.test(x));
  check('the self-test touched nothing outside loopback (network guard)', external.length === 0, external.join(','));
  net.connect = realConnect;

  // 14. static guards on this file
  const src = fs.readFileSync(__filename, 'utf8');
  const split = src.indexOf('async function selfTest');
  const prod = src.slice(0, split);
  const term = (...p) => p.join('');
  // (checks look at CODE only: comments are stripped, and search terms are assembled from pieces so a check never matches its own text)
  const code = prod.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('never references DATABASE_URL, .env files, or any database library', !code.includes(term('DATABASE', '_URL')) && !/require\((['"])(@prisma|prisma|pg|mysql|mysql2)/.test(code) && !/loadEnvFile|dotenv|readFileSync/.test(code) && !/['"`][^'"`]*\.env['"`]/.test(code));
  const mods = [...src.matchAll(/require\('node:([a-z_]+)'\)/g)].map((m) => m[1]).sort();
  check('uses only Node core modules; crypto appears ONLY in the self-test; no http/https', mods.every((m) => ['dns', 'fs', 'net', 'os', 'path', 'tls', 'crypto', 'child_process'].includes(m)) && !mods.includes(term('ht', 'tp')) && !mods.includes(term('ht', 'tps')) && !code.includes(term('node:', 'crypto')));
  check('the ONE place a process is started: a single spawn() of this same Node binary with an explicit environment object, no shell, no exec/fork',
    (code.match(/\bspawn\(/g) || []).length === 1 && /spawn\(o\.exec, o\.args, \{ env: o\.env,/.test(code) && !/shell:/.test(code) && !/\bexec(Sync|File|FileSync)?\(|\bfork\(/.test(code) && /exec: process\.execPath/.test(code)
    && !/\.\.\.process\.env|env:\s*process\.env/.test(src));
  check('the child environment allow-list is exactly the three GHARSE_NET_PROBE variables and the temp-folder variables', JSON.stringify(CHILD_ENV_NAMES) === JSON.stringify(['GHARSE_NET_PROBE', 'GHARSE_NET_PROBE_HOST', 'GHARSE_NET_PROBE_PORT', 'TMPDIR', 'TMP', 'TEMP']));
  const envUses = (src.match(/process\.env[[.]/g) || []).length;
  check('process.env is read in exactly two helper lines (allow-listed names, and proxy presence only)', envUses === 2 && code.includes('const envGet =') && code.includes('const envHas ='), String(envUses));
  check('adds no listener, HTTP route or server in the production path', !/createServer\(|\.listen\(/.test(code));
  check('exactly one file write in the production code (the once-per-container marker)', (code.match(/writeFileSync\(/g) || []).length === 1 && !new RegExp(['append', 'File|createWrite', 'Stream|mkdir', 'Sync|rename', 'Sync|copy', 'File'].join('')).test(code));
  check('certificate verification is on for the primary handshake and off only in the single labelled follow-up', /verify: true/.test(code) && /verify: false/.test(code) && (code.match(/rejectUnauthorized: verify/g) || []).length === 1 && !new RegExp(term('reject', 'Unauthorized: false')).test(src));
  check('deadlines: the supervisor kills at 15 s, the probe reports at 13 s; every exit the code makes is exit(0) (or follows an outside signal)', /const HARD_DEADLINE_MS = 15000/.test(prod) && /const CHILD_BUDGET_MS = 13000/.test(prod) && !/\bo\.exit\((?!0\))/.test(code) && (code.match(/o\.exit\(0\)/g) || []).length === 2 && !/process\.exit\((1|2)\b/.test(code) && /process\.exit\(128 \+ num\)/.test(code));

  // 15. the start command is unchanged and the hook is the only addition
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  check('root package.json: start is unchanged and prestart runs only this file', pkg.scripts.start === 'node server/dist/server.js' && pkg.scripts.prestart === 'node tools/net-probe/probe.cjs', JSON.stringify([pkg.scripts.start, pkg.scripts.prestart]));

  for (const s of servers) s.close();
  let ok = true;
  for (const [n, pass, detail] of checks) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}${!pass && detail ? `\n      detail: ${detail}` : ''}`); ok = ok && pass; }
  for (const n of notes) console.log(`NOTE  ${n}`);
  console.log(ok ? `\nself-test OK (${checks.length} checks)` : '\nself-test FAILED');
  process.exit(ok ? 0 : 1);
}

module.exports = { runProbe, runSupervisor, buildChildEnv, precheck, envGet, SENTINEL }; // for the self-test; no effect when run as a script

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) {
    selfTest();
  } else if (argv.includes('--child')) {
    // A crash or stray rejection must still finish the report cleanly.
    const bail = (cls) => { console.log(`[net-probe] unexpected error${cls ? ` (class ${cls})` : ''}; the diagnostic stopped`); console.log(SENTINEL); process.exit(0); };
    process.on('uncaughtException', (e) => bail(safeName(e)));
    process.on('unhandledRejection', () => bail(''));
    runProbe(childDeps(argv));
  } else {
    process.on('uncaughtException', () => { console.log('[net-probe] unexpected error in the supervisor; the application start is not affected'); process.exit(0); });
    supervisorMain();
  }
}
