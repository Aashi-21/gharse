import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveInside } from '../src/lib/staticSpa';

const root = path.resolve('/srv/app/public');

describe('static path resolution', () => {
  it('maps normal paths inside the root', () => {
    assert.equal(resolveInside(root, '/assets/app.js?v=1'), path.join(root, 'assets/app.js'));
    assert.equal(resolveInside(root, '/'), root);
  });
  it('never escapes the root', () => {
    for (const p of ['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/../../secret', '//etc/passwd']) {
      const r = resolveInside(root, p);
      assert.ok(r === null || r === root || r.startsWith(root + path.sep), `${p} -> ${r}`);
    }
  });
  it('rejects null bytes, backslashes and malformed encodings', () => {
    for (const p of ['/a%00b', '/a%5Cb', '/%E0%A4%A']) assert.equal(resolveInside(root, p), null, p);
  });
});
