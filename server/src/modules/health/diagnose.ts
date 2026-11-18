/**
 * TEMPORARY health-check diagnostics (deploy branch only).
 *
 * Turns an error thrown by a health check into a few SAFE fields for the log: the error's class name, its code, whether
 * our own 5 s guard fired, and one sanitized line of its message. Nothing else from the error is logged (no stack, no
 * `meta`, no connection details). Anything that could identify the database, the mailbox or the network is masked.
 */
import net from 'node:net';
import type { Config } from '../../config';

/** Thrown by the health check's own timeout guard. Its message stays "timeout", exactly as before. */
export class HealthTimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'HealthTimeoutError';
  }
}

export interface HealthFailure {
  check: string;
  errName: string;
  errCode?: string;
  timeout: boolean;
  ms: number;
  detail: string;
}

const MAX_DETAIL = 200;
/** The pattern-based masks below can be slow on huge input, and only MAX_DETAIL characters are kept, so work on at most this much. */
const MAX_INPUT = 2000;
const MIN_SECRET = 3; // shorter values would blank out ordinary words; real credentials are far longer
const REDACTED = '<redacted>';
/** URL query parameters whose values are credentials (for example password, sslpassword, sslcert, options). */
const SENSITIVE_PARAM = /pass|pwd|secret|token|key|cert|user|options/i;

/** Every form a value can take inside an error message: as given, percent-decoded, percent-encoded and base64. */
export function secretVariants(value: string | undefined): string[] {
  if (!value || value.length < MIN_SECRET) return [];
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    /* not percent-encoded */
  }
  const out = new Set<string>();
  for (const v of [value, decoded]) {
    out.add(v);
    out.add(encodeURIComponent(v));
    out.add(Buffer.from(v, 'utf8').toString('base64'));
  }
  return [...out].filter((v) => v.length >= MIN_SECRET);
}

/** Exact values that must never reach a log line: every part of the database URL, in every form above. */
export function secretsFromUrl(url: string | undefined): string[] {
  if (!url) return [];
  const out = new Set<string>([url]);
  const add = (v: string | undefined) => secretVariants(v).forEach((x) => out.add(x));
  try {
    const u = new URL(url);
    add(u.hostname); // an IPv6 host keeps its brackets here; the IPv6 masking in sanitizeDetail covers the bare address
    add(u.host); // host:port
    add(u.username);
    add(u.password);
    add(u.pathname.replace(/^\/+/, '')); // database name
    for (const [key, value] of u.searchParams) if (SENSITIVE_PARAM.test(key)) add(value);
  } catch {
    // Malformed URL: be conservative. Take the credentials (everything before the LAST "@", so a password that itself
    // contains "@" is kept whole), the host part after it, and every long-enough piece.
    const rest = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const at = rest.lastIndexOf('@');
    if (at >= 0) {
      const userinfo = rest.slice(0, at);
      add(userinfo);
      for (const piece of userinfo.split(/\s+/)) add(piece);
      const colon = userinfo.indexOf(':');
      if (colon >= 0) {
        for (const part of [userinfo.slice(0, colon), userinfo.slice(colon + 1)]) {
          add(part);
          for (const piece of part.split(/\s+/)) add(piece);
        }
      }
    }
    add(rest.slice(at + 1).split(/[/?#]/)[0]);
    for (const piece of url.split(/[:/@?&=\s]+/)) add(piece);
  }
  return [...out];
}

/**
 * Everything configured that must never appear in a health log line. Typed against the real Config, so a property name
 * that does not exist fails the type-check instead of silently masking nothing.
 */
export function healthLogSecrets(c: Pick<Config, 'DATABASE_URL' | 'SMTP_HOST' | 'SMTP_USER' | 'SMTP_PASS' | 'MAIL_FROM' | 'CONTACT_TO'>): string[] {
  const out = new Set<string>(secretsFromUrl(c.DATABASE_URL));
  const add = (v: string | undefined) => secretVariants(v).forEach((x) => out.add(x));
  add(c.SMTP_HOST);
  add(c.SMTP_USER);
  add(c.SMTP_PASS);
  // Addresses may be written as `Name <a@b.c>` or as a comma-separated list: mask each entry, and each bare address in it.
  for (const field of [c.MAIL_FROM, c.CONTACT_TO]) {
    for (const piece of (field ?? '').split(/[,;]/)) {
      add(piece.trim());
      add(piece.match(/<([^>]+)>/)?.[1]?.trim());
    }
  }
  // SMTP AUTH PLAIN sends base64("\0user\0password"); mask that exact string as well.
  if (c.SMTP_USER && c.SMTP_PASS) out.add(Buffer.from(`\u0000${c.SMTP_USER}\u0000${c.SMTP_PASS}`, 'utf8').toString('base64'));
  return [...out];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Masks every valid IPv6 address, including compressed forms (::1, 2001:db8::1), bracketed ones, zone ids and IPv4-mapped ones. */
function maskIpv6(text: string): string {
  // [addr] or [addr]:port
  let s = text.replace(/\[([0-9a-f:.]+)(?:%[\w.-]+)?\](?::\d+)?/gi, (m, ip: string) => (net.isIPv6(ip) ? '<ip>' : m));
  // bare addresses; a "." or ":" that merely ends a sentence is kept out of the address
  s = s.replace(/(?<![\w])[0-9a-f:.]*:[0-9a-f:.]*(?:%[\w.-]+)?/gi, (m) => {
    const core = m.replace(/%[\w.-]+$/, '');
    if (core === '::') return m; // the unspecified address identifies nothing, and "::" also appears in names such as Foo<int>::bar
    for (const tail of ['', '.', ':', '..']) {
      if (core.endsWith(tail) && net.isIPv6(core.slice(0, core.length - tail.length))) return `<ip>${tail}`;
    }
    return m;
  });
  return s;
}

/** Masks anything that could identify the database, the mailbox or the network. Single line, length-capped. */
export function sanitizeDetail(text: string, secrets: string[]): string {
  let s = text;
  // Longest first, so a full URL is removed before its parts.
  for (const secret of [...secrets].filter((v) => v.length >= MIN_SECRET).sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(escapeRegExp(secret), 'gi'), REDACTED);
  }
  // Exact secrets are gone from the WHOLE text at this point, so cutting it cannot leave a fragment of one. Cut at a space
  // so that no address, host or URL is split in two.
  if (s.length > MAX_INPUT) {
    const head = s.slice(0, MAX_INPUT);
    const space = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\t'));
    s = space > 0 ? head.slice(0, space) : head;
  }
  s = maskIpv6(
    s
      .replace(/[a-z][a-z0-9+.-]*:\/\/\S*/gi, '<url>') // any connection string / URL
      .replace(/`[^`]*[.:@][^`]*`/g, REDACTED), // Prisma quotes the host:port in backticks
  );
  s = s
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>') // IPv4 (+ port)
    .replace(/\b(?:[a-z0-9-]+\.){2,}[a-z]{2,}(?::\d+)?\b/gi, '<host>') // any dotted host name (+ port)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}...` : s;
}

/** First meaningful line of an error message. Prisma starts many messages with an "Invalid `...` invocation:" header. */
function firstLine(message: string): string {
  const lines = message.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => !/^Invalid\s+`[^`]*`\s+invocation:?$/i.test(l)) ?? '';
}

const SAFE_NAME = /^[A-Za-z0-9_$.]{1,60}$/;
const SAFE_CODE = /^[A-Za-z0-9_]{2,32}$/;

export function describeHealthFailure(check: string, err: unknown, secrets: string[], ms: number): HealthFailure {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { name?: unknown; code?: unknown; errorCode?: unknown; message?: unknown };
  const name = typeof e.name === 'string' && SAFE_NAME.test(e.name) ? e.name : 'UnknownError';
  // Prisma's initialization errors carry the code in `errorCode`; known-request and Node errors use `code`.
  const rawCode = typeof e.code === 'string' ? e.code : typeof e.errorCode === 'string' ? e.errorCode : undefined;
  const failure: HealthFailure = {
    check: SAFE_NAME.test(check) ? check : 'unknown',
    errName: name,
    timeout: err instanceof HealthTimeoutError,
    ms: Math.max(0, Math.round(ms)),
    detail: typeof e.message === 'string' ? sanitizeDetail(firstLine(e.message), secrets) : '',
  };
  if (rawCode && SAFE_CODE.test(rawCode)) failure.errCode = rawCode;
  return failure;
}

/** The text of the log message itself, so it is visible even in log viewers that show only the message. */
export function healthFailureMessage(f: HealthFailure): string {
  return `health check failed [${f.check}] name=${f.errName} code=${f.errCode ?? 'none'} timeout=${f.timeout} ms=${f.ms} detail=${JSON.stringify(f.detail)}`;
}
