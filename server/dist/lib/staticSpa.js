"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveInside = resolveInside;
exports.sendSpa = sendSpa;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// Minimal static file serving for the built SPA. Deliberately tiny and dependency-free so it
// runs on any Node >= 20 (current @fastify/static needs require(esm), i.e. Node 22+).
const MIME = {
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
function resolveInside(root, urlPath) {
    let decoded;
    try {
        decoded = decodeURIComponent(urlPath.split('?')[0]);
    }
    catch {
        return null;
    }
    if (decoded.includes('\0') || decoded.includes('\\'))
        return null;
    const full = node_path_1.default.resolve(root, '.' + node_path_1.default.posix.normalize('/' + decoded));
    if (full !== root && !full.startsWith(root + node_path_1.default.sep))
        return null;
    return full;
}
/** Serves a real file under root, or the SPA index.html for client-side routes. */
function sendSpa(root, urlPath, reply) {
    const target = resolveInside(root, urlPath);
    if (target === null)
        return reply.code(400).send({ error: { code: 'bad_request', message: 'Bad request' } });
    let file = node_path_1.default.join(root, 'index.html');
    let isAsset = false;
    try {
        if (target !== root && node_fs_1.default.statSync(target).isFile()) {
            file = target;
            isAsset = true;
        }
    }
    catch {
        /* not a file -> SPA fallback */
    }
    // A missing file that looks like an asset (has an extension) is a real 404, not the SPA.
    if (!isAsset && node_path_1.default.extname(urlPath.split('?')[0]) !== '') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    }
    const hashed = isAsset && file.startsWith(node_path_1.default.join(root, 'assets') + node_path_1.default.sep);
    return reply
        .header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
        .type(MIME[node_path_1.default.extname(file).toLowerCase()] ?? 'application/octet-stream')
        .send(node_fs_1.default.createReadStream(file));
}
//# sourceMappingURL=staticSpa.js.map