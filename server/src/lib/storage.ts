import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config';

export interface Storage {
  driver: string;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Throws if storage is not usable (used by /api/health). */
  check(): Promise<void>;
}

async function unlinkQuiet(file: string) {
  try {
    await fs.unlink(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

export function createStorage(config: Config): Storage {
  const root = config.uploadDir;

  // Reject keys that escape the upload directory.
  const resolveKey = (key: string) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error('invalid storage key');
    return full;
  };

  return {
    driver: 'local',
    async put(key, data) {
      const full = resolveKey(key);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, data);
    },
    get: (key) => fs.readFile(resolveKey(key)),
    delete: (key) => unlinkQuiet(resolveKey(key)),
    async check() {
      await fs.mkdir(root, { recursive: true });
      const full = resolveKey(`.healthcheck-${randomBytes(6).toString('hex')}`);
      const payload = randomBytes(8);
      await fs.writeFile(full, payload);
      try {
        const back = await fs.readFile(full);
        if (!back.equals(payload)) throw new Error('storage read-back mismatch');
      } finally {
        await unlinkQuiet(full);
      }
    },
  };
}
