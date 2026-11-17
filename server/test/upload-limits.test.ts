import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../src/lib/httpError';
import { IMAGE_LIMITS } from '../src/lib/imageInfo';
import { readProductUpload } from '../src/modules/products/upload';
import { jpegOfExactSize } from './images';

// Feeds the upload parser directly, bypassing the multipart plugin, so the defensive length check
// (a second layer behind the plugin's own limit) is exercised on its own.
const fakeRequest = (file: Buffer) =>
  ({
    isMultipart: () => true,
    async *parts() {
      yield { type: 'file', fieldname: 'image', toBuffer: async () => file };
    },
  }) as never;

describe('upload size limit: single shared constant + defensive check', () => {
  it('the shared limit is exactly 5 MiB', () => {
    assert.equal(IMAGE_LIMITS.maxBytes, 5_242_880);
  });

  it('accepts a valid image of exactly the limit', async () => {
    const up = await readProductUpload(fakeRequest(jpegOfExactSize(IMAGE_LIMITS.maxBytes)));
    assert.equal(up.image.length, 5_242_880);
    assert.equal(up.info.mime, 'image/jpeg');
  });

  it('rejects a valid image one byte over the limit even if the plugin let it through', async () => {
    await assert.rejects(
      () => readProductUpload(fakeRequest(jpegOfExactSize(IMAGE_LIMITS.maxBytes + 1))),
      (err: unknown) =>
        err instanceof HttpError &&
        err.statusCode === 413 &&
        err.code === 'image_too_large' &&
        err.message === 'The photo is too large. Please use one under 5 MB.',
    );
  });

  it('is rejected on size BEFORE any signature or dimension check', async () => {
    // 6 MiB of zeros has no image signature at all; the size error must win.
    await assert.rejects(
      () => readProductUpload(fakeRequest(Buffer.alloc(IMAGE_LIMITS.maxBytes + 1024))),
      (err: unknown) => err instanceof HttpError && err.code === 'image_too_large',
    );
  });
});
