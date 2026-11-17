import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply } from 'fastify';

// Minimal static file serving for the built SPA. Deliberately tiny and dependency-free so it
// runs on any Node >= 20 (current @fastify/static needs require(esm), i.e. Node 22+).
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolves a request path to a file strictly inside `root`, or null. */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const full = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/** Serves a real file under root, or the SPA index.html for client-side routes. */
export function sendSpa(root: string, urlPath: string, reply: FastifyReply) {
  const target = resolveInside(root, urlPath);
  if (target === null) return reply.code(400).send({ error: { code: 'bad_request', message: 'Bad request' } });

  let file = path.join(root, 'index.html');
  let isAsset = false;
  try {
    if (target !== root && fs.statSync(target).isFile()) {
      file = target;
      isAsset = true;
    }
  } catch {
    /* not a file -> SPA fallback */
  }
  // A missing file that looks like an asset (has an extension) is a real 404, not the SPA.
  if (!isAsset && path.extname(urlPath.split('?')[0]) !== '') {
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  }
  const hashed = isAsset && file.startsWith(path.join(root, 'assets') + path.sep);
  return reply
    .header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
    .type(MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream')
    .send(fs.createReadStream(file));
}
