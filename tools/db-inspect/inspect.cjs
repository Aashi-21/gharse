#!/usr/bin/env node
/**
 * READ-ONLY inspection of the GoDaddy MySQL/MariaDB database for the GharSe migration decision.
 *
 *   node tools/db-inspect/inspect.cjs            run the inspection (needs DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD)
 *   node tools/db-inspect/inspect.cjs --selftest check the safety features without any database
 *
 * Safety:
 *  - Only SELECT / SHOW statements are ever sent (enforced by an allow-list; nothing is created, altered or deleted).
 *  - The database session is also switched to READ ONLY on the server (SET SESSION TRANSACTION READ ONLY) and re-checked
 *    before every query, so even a bug in the allow-list could not write. If the server cannot do this it is reported.
 *  - Credentials come only from environment variables and are NEVER printed: every line of output passes through
 *    redact(), which also masks the host, user and database name.
 *  - Reachability is tested with a plain TCP connect first (no credentials involved).
 */
'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const NEEDED = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const READ_ONLY = /^\s*(SELECT|SHOW)\b/i;
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|REPLACE|SET|CALL|LOCK|LOAD|RENAME)\b/i;

// Host, database name, user and password are masked everywhere. The port is not a credential, so it stays readable.
const secrets = () => {
  const plainValues = NEEDED.filter((k) => k !== 'DB_PORT').map((k) => process.env[k]).filter((v) => v && v.length >= 2);
  return [...new Set(plainValues.flatMap((v) => [v, encodeURIComponent(v)]))];
};

/** Masks credentials and identifying connection details anywhere in a string. */
function redact(text, values = secrets()) {
  let s = String(text);
  for (const v of values.sort((a, b) => b.length - a.length)) s = s.split(v).join('<redacted>');
  s = s.replace(/IDENTIFIED BY (PASSWORD )?'[^']*'/gi, "IDENTIFIED BY <redacted>");
  s = s.replace(/mysql:\/\/[^\s]+/gi, 'mysql://<redacted>');
  return s;
}
const out = (line = '') => console.log(redact(line));

function assertReadOnly(sql) {
  if (!READ_ONLY.test(sql) || FORBIDDEN.test(sql.replace(/'[^']*'/g, "''"))) throw new Error('refusing to run a non read-only statement');
}

function selfTest() {
  const fake = ['db.example.test', 'cpuser_gharse', 'cpuser', 'p@ss/w0rd!'];
  const line = "GRANT ALL PRIVILEGES ON `cpuser_gharse`.* TO 'cpuser'@'db.example.test' IDENTIFIED BY PASSWORD '*ABCDEF' url mysql://cpuser:p%40ss@db.example.test/x pw p@ss/w0rd!";
  const r = redact(line, fake);
  const leaked = fake.concat(['*ABCDEF', 'mysql://cpuser']).filter((v) => r.includes(v));
  const results = [
    ['redaction removes host, user, db name, password, hash and URLs', leaked.length === 0],
    ['allows SELECT', (() => { try { assertReadOnly('SELECT 1'); return true; } catch { return false; } })()],
    ['allows SHOW GRANTS', (() => { try { assertReadOnly('SHOW GRANTS'); return true; } catch { return false; } })()],
    ...['DROP TABLE x', 'DELETE FROM x', 'INSERT INTO x VALUES (1)', 'UPDATE x SET a=1', 'CREATE TABLE x (a int)', 'SET GLOBAL x=1', 'SELECT 1; DROP TABLE x'].map(
      (q) => [`refuses: ${q}`, (() => { try { assertReadOnly(q); return false; } catch { return true; } })()],
    ),
  ];
  // encoded forms of the password appear inside connection strings in error text
  const encPw = 'p@ss/w0rd!';
  results.push(['redaction also removes the URL-encoded password', !redact('mysql-error ' + encodeURIComponent(encPw) + ' end', [encPw, encodeURIComponent(encPw)]).includes(encodeURIComponent(encPw))]);
  let okAll = true;
  for (const [name, pass] of results) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); okAll = okAll && pass; }
  // server-side read-only enforcement, exercised against stub connections
  const stub = (exec, query) => ({ $executeRawUnsafe: exec, $queryRawUnsafe: query });
  const ran = [];
  const good = stub(async (q) => { ran.push(q); return 0; }, async () => [{ ro: 1 }]);
  const unsupported = stub(async () => { throw new Error('syntax error'); }, async () => [{ ro: 0 }]);
  const unconfirmed = stub(async () => 0, async () => [{ ro: 0 }]);
  const unreadable = stub(async () => 0, async () => { throw new Error('unknown system variable'); });
  Promise.all([enforceReadOnlySession(good), enforceReadOnlySession(unsupported), enforceReadOnlySession(unconfirmed), enforceReadOnlySession(unreadable)]).then(([a, b, c, d]) => {
    const more = [
      ['read-only session: confirmed by the server -> enforced', a === 'enforced' && ran[0] === READ_ONLY_SESSION_SQL],
      ['read-only session: server cannot do it -> reported unsupported (allow-list only)', b === 'unsupported'],
      ['read-only session: server says NOT read-only -> failed (inspection would stop)', c === 'failed'],
      ['read-only session: cannot be verified -> failed (inspection would stop)', d === 'failed'],
    ];
    // static guards on this file's own source: the only non-SELECT/SHOW statement is the fixed session setting
    const src = fs.readFileSync(__filename, 'utf8');
    // (search terms are assembled from pieces so this check does not match its own text)
    const rawCall = '$executeRaw' + 'Unsafe(';
    more.push(['source: exactly one raw-execute call, and it sends the fixed read-only statement', src.split(rawCall).length - 1 === 1 && src.includes(rawCall + 'READ_ONLY_SESSION_SQL)')]);
    const banned = ['mi' + 'grate', 'db ' + 'push', 'schema-' + 'engine'];
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    more.push(['source: no schema-migration tooling is referenced', !banned.some((w) => code.includes(w))]);
    more.push(['source: no file writes', !/(writeFile|appendFile|createWriteStream|mkdirSync|unlinkSync)/.test(src.replace(/'[^']*'/g, ''))]);
    let ok2 = true;
    for (const [name, pass] of more) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); ok2 = ok2 && pass; }
    console.log(ok2 && okAll ? '\nself-test OK' : '\nself-test FAILED');
    process.exit(ok2 && okAll ? 0 : 1);
  });
  return;
}

function tcpCheck(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 6000 });
    s.once('connect', () => { s.destroy(); resolve({ ok: true }); });
    s.once('timeout', () => { s.destroy(); resolve({ ok: false, why: 'timed out (firewall or not allow-listed?)' }); });
    s.once('error', (e) => resolve({ ok: false, why: e.code || 'error' }));
  });
}

const CHECKS = [
  ['server', ['SELECT VERSION() AS version, @@version_comment AS flavour, @@version_compile_os AS os']],
  ['default storage engine', ['SELECT @@default_storage_engine AS default_engine']],
  ['engine support', ["SELECT ENGINE, SUPPORT, TRANSACTIONS, SAVEPOINTS FROM information_schema.ENGINES WHERE ENGINE IN ('InnoDB','MyISAM','Aria')"]],
  ['existing tables by engine', ['SELECT ENGINE, COUNT(*) AS tables_with_engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() GROUP BY ENGINE']],
  ['database charset', ['SELECT DEFAULT_CHARACTER_SET_NAME AS db_charset, DEFAULT_COLLATION_NAME AS db_collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()']],
  ['server charset', ['SELECT @@character_set_server AS server_charset, @@collation_server AS server_collation, @@character_set_connection AS connection_charset']],
  ['isolation level', ['SELECT @@transaction_isolation AS isolation', 'SELECT @@tx_isolation AS isolation']],
  ['transaction settings', ['SELECT @@autocommit AS autocommit, @@innodb_lock_wait_timeout AS lock_wait_timeout_s, @@foreign_key_checks AS foreign_key_checks']],
  ['sql_mode', ['SELECT @@sql_mode AS sql_mode']],
  ['table name case', ['SELECT @@lower_case_table_names AS lower_case_table_names']],
  ['row format', ['SELECT @@innodb_default_row_format AS default_row_format']],
  ['connection limits', ['SELECT @@max_connections AS max_connections, @@max_user_connections AS max_user_connections, @@wait_timeout AS wait_timeout_s']],
  ['current connections', ["SHOW STATUS LIKE 'Threads_connected'"]],
  ['packet / time zone', ['SELECT @@max_allowed_packet AS max_allowed_packet, @@time_zone AS time_zone, @@system_time_zone AS system_time_zone']],
  ['CHECK constraint view present', ["SELECT COUNT(*) AS present FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'information_schema' AND TABLE_NAME = 'CHECK_CONSTRAINTS'"]],
  ['TLS support', ['SELECT @@have_ssl AS have_ssl', "SHOW VARIABLES LIKE 'have_ssl'"]],
  ['TLS required', ['SELECT @@require_secure_transport AS require_secure_transport']],
  ['TLS on this connection', ["SHOW STATUS LIKE 'Ssl_cipher'"]],
  ['grants', ['SHOW GRANTS']],
  ['tables already in database', ['SELECT COUNT(*) AS tables_in_database FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()']],
];

/** Never wait forever: a server that accepts the connection but does not speak MySQL would otherwise hang us. */
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s (the server accepted the connection but did not answer like MySQL/MariaDB, or the network is blocking it)`)), ms))]);

const plain = (rows) => JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
// SECOND safety layer behind the allow-list. This one fixed statement is the only non-SELECT/SHOW thing ever sent; it only
// restricts the session and cannot change data or schema. The single pooled connection is re-checked before every query.
const READ_ONLY_SESSION_SQL = 'SET SESSION TRANSACTION READ ONLY';
const READ_ONLY_VERIFY = ['SELECT @@session.transaction_read_only AS ro', 'SELECT @@session.tx_read_only AS ro'];
/** @returns {'enforced'|'unsupported'|'failed'} enforced: server confirms read-only; unsupported: server cannot do it; failed: could not confirm. */
async function enforceReadOnlySession(prisma, timeoutMs = 15000) {
  try {
    await withTimeout(prisma.$executeRawUnsafe(READ_ONLY_SESSION_SQL), timeoutMs, 'read-only setup');
  } catch {
    return 'unsupported';
  }
  for (const q of READ_ONLY_VERIFY) {
    try {
      assertReadOnly(q);
      const rows = plain(await withTimeout(prisma.$queryRawUnsafe(q), timeoutMs, 'read-only check'));
      return Number(Object.values(rows[0] || {})[0]) === 1 ? 'enforced' : 'failed';
    } catch { /* try the older variable name */ }
  }
  return 'failed';
}

const first = (res) => (res && res.rows && res.rows[0]) || {};
const val = (res, k) => { const r = first(res); const key = Object.keys(r).find((x) => x.toLowerCase() === k.toLowerCase()); return key ? r[key] : undefined; };

async function main() {
  if (process.argv.includes('--selftest')) return selfTest();

  const missing = NEEDED.filter((k) => !process.env[k]);
  if (missing.length) {
    out(`Missing environment variables: ${missing.join(', ')}`);
    out('Set them in YOUR terminal (never in a file or chat). To enter the password without it appearing on screen or in history:');
    out('  export DB_HOST=...  DB_PORT=...  DB_NAME=...  DB_USER=...');
    out('  read -s DB_PASSWORD && export DB_PASSWORD');
    process.exit(2);
  }

  out('=== 1. Reachability (plain TCP, no credentials) ===');
  const local = /^(localhost|127\.|::1$)/.test(process.env.DB_HOST);
  const tcp = await tcpCheck(process.env.DB_HOST, Number(process.env.DB_PORT));
  out(`host kind: ${local ? 'LOCAL to this machine (localhost): only reachable from the machine the database runs on' : /^\d+\.\d+\.\d+\.\d+$/.test(process.env.DB_HOST) ? 'IP address' : 'hostname'}`);
  out(`port: ${process.env.DB_PORT}`);
  out(`TCP connect from THIS machine: ${tcp.ok ? 'REACHABLE' : `NOT reachable (${tcp.why})`}`);
  if (!tcp.ok) {
    out('\nThe database is not reachable from here. On GoDaddy this usually means one of:');
    out('  - the host is internal (only the hosting server can connect): run this script in the GoDaddy terminal instead, or use tools/db-inspect/inspect.sql in phpMyAdmin;');
    out('  - remote access is not enabled: add your IP under cPanel > Remote MySQL, then retry.');
    process.exit(3);
  }

  const clientDir = path.join(__dirname, '.client');
  if (!fs.existsSync(clientDir)) {
    out('\nGenerate the isolated read-only client first (no database needed):');
    out('  node node_modules/prisma/build/index.js generate --schema tools/db-inspect/schema.prisma');
    process.exit(4);
  }
  const { PrismaClient } = require(clientDir);
  const enc = encodeURIComponent;
  const ssl = { strict: 'strict', accept_invalid_certs: 'accept_invalid_certs' }[process.env.DB_INSPECT_SSL || ''];
  const url = `mysql://${enc(process.env.DB_USER)}:${enc(process.env.DB_PASSWORD)}@${process.env.DB_HOST}:${process.env.DB_PORT}/${enc(process.env.DB_NAME)}?connection_limit=1&connect_timeout=10&pool_timeout=10${ssl ? `&sslaccept=${ssl}` : ''}`;
  const prisma = new PrismaClient({ datasourceUrl: url, log: [] });

  const results = {};
  let readOnlyMode = 'unknown';
  out('\n=== 2. Authenticated read-only inspection ===');
  out(`(TLS mode requested: ${ssl || 'Prisma default'}; set DB_INSPECT_SSL=strict or accept_invalid_certs to test others)`);
  for (const [name, candidates] of CHECKS) {
    let done = false;
    let lastErr = '';
    for (const sql of candidates) {
      try {
        assertReadOnly(sql);
        const mode = name === 'server' ? 'unchecked' : await enforceReadOnlySession(prisma);
        if (mode === 'failed') { out('\nThe server accepted read-only mode but did not confirm it, so the inspection stopped rather than risk it.'); process.exit(7); }
        readOnlyMode = mode === 'unchecked' ? readOnlyMode : mode;
        const rows = plain(await withTimeout(prisma.$queryRawUnsafe(sql), name === 'server' ? 20000 : 15000, 'query'));
        results[name] = { rows };
        out(`\n[${name}]`);
        for (const r of rows) out('  ' + JSON.stringify(r));
        done = true;
        break;
      } catch (e) {
        lastErr = String(e.message || e).split('\n').filter(Boolean).slice(-1)[0];
        if (name === 'server') {
          out(`\nCould not connect/authenticate: ${lastErr}`);
          out('If it mentions TLS/SSL, retry with DB_INSPECT_SSL=accept_invalid_certs (then strict). If access was denied, check the user and password.');
          process.exit(5); // exit immediately: do not wait on a connection that may never close
        }
      }
    }
    if (!done) { results[name] = { error: lastErr }; out(`\n[${name}]\n  not available on this server (${lastErr.slice(0, 140)})`); }
  }
  await prisma.$disconnect();

  // ---- preliminary assessment (inference from the numbers above; the spike will PROVE behaviour) ----
  const version = String(val(results.server, 'version') || '');
  const isMaria = /mariadb/i.test(version + ' ' + String(val(results.server, 'flavour') || ''));
  const [maj, min, pat] = (version.match(/(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0]).slice(1).map(Number);
  const at = (a, b, c) => maj > a || (maj === a && (min > b || (min === b && pat >= c)));
  const checkEnforced = isMaria ? at(10, 2, 1) : at(8, 0, 16);
  const engineOk = /innodb/i.test(String(val(results['default storage engine'], 'default_engine') || ''))
    && !(results['existing tables by engine']?.rows || []).some((r) => !/innodb/i.test(String(Object.values(r)[0])));
  const utf8mb4 = /utf8mb4/i.test(String(val(results['database charset'], 'db_charset') || ''));
  const maxUser = Number(val(results['connection limits'], 'max_user_connections') || 0);
  const hasInnoDb = (results['engine support']?.rows || []).some((r) => /innodb/i.test(r.ENGINE || r.engine) && /(YES|DEFAULT)/i.test(r.SUPPORT || r.support));
  const grants = JSON.stringify(results.grants?.rows || '');
  const grantOk = /ALL PRIVILEGES/i.test(grants) || ['CREATE', 'ALTER', 'INDEX', 'REFERENCES', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'].every((p) => grants.toUpperCase().includes(p));
  const tls = String(val(results['TLS on this connection'], 'Value') || '');

  out('\n=== 3. Preliminary assessment (inferred; to be proven by the compatibility spike) ===');
  const line = (status, text) => out(`${status.padEnd(5)} ${text}`);
  line(isMaria ? 'INFO' : 'INFO', `server: ${isMaria ? 'MariaDB' : 'MySQL'} ${version || '(unknown)'}`);
  line(engineOk && hasInnoDb ? 'PASS' : 'FAIL', 'InnoDB is the default engine, is supported, and no existing table uses another engine (MANDATORY)');
  line(utf8mb4 ? 'PASS' : 'WARN', 'database charset is utf8mb4' + (utf8mb4 ? '' : ' (tables can still be created as utf8mb4 explicitly)'));
  line(checkEnforced ? 'PASS' : 'WARN', `CHECK constraints are ${checkEnforced ? 'enforced (version is new enough)' : 'NOT enforced on this version: database-level safety nets would be lost, application checks remain'}`);
  line(isMaria ? (at(10, 2, 7) ? 'PASS' : 'WARN') : (at(5, 7, 8) ? 'PASS' : 'WARN'), `JSON columns ${isMaria ? '(MariaDB stores JSON as validated text)' : '(native JSON)'} look supported by this version`);
  line(grantOk ? 'PASS' : 'WARN', 'grants appear to include CREATE, ALTER, INDEX, REFERENCES and data access');
  line(maxUser === 0 ? 'PASS' : maxUser >= 6 ? 'PASS' : 'WARN', `per-user connection cap: ${maxUser === 0 ? 'none' : maxUser}; suggested DB_CONNECTION_LIMIT=${maxUser === 0 ? 5 : Math.max(1, Math.min(5, maxUser - 1))}`);
  line(tls ? 'INFO' : 'INFO', `this connection used TLS: ${tls ? 'yes' : 'no / not reported'}`);
  line(readOnlyMode === 'enforced' ? 'PASS' : 'INFO', `server-side read-only session: ${readOnlyMode === 'enforced' ? 'ENFORCED and confirmed by the server' : readOnlyMode === 'unsupported' ? 'not supported by this server (the SELECT/SHOW allow-list was the only guard)' : 'unknown'}`);
  out('\nHard gate: any FAIL above (especially InnoDB) means STOP before any code change.');
  out('Share this output (it contains no credentials) to get the go/no-go recommendation.');
}

if (require.main === module) {
  setTimeout(() => { console.log('Stopped: the inspection took longer than 3 minutes.'); process.exit(6); }, 180000).unref();
  main().catch((e) => { out('Unexpected error: ' + (e && e.message ? e.message.split('\n').slice(-1)[0] : e)); process.exit(1); });
}
module.exports = { redact, secrets, assertReadOnly, enforceReadOnlySession, NEEDED };
