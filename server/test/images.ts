// Builds minimal-but-structurally-valid image headers so the validator is tested on real byte layouts.

export function pngBytes(w = 640, h = 480, pad = 64): Buffer {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8; b[25] = 2;
  return b;
}

export function jpegBytes(w = 640, h = 480, pad = 64, sof = 0xc0): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const frame = Buffer.alloc(19);
  frame[0] = 0xff; frame[1] = sof; frame.writeUInt16BE(17, 2); frame[4] = 8;
  frame.writeUInt16BE(h, 5); frame.writeUInt16BE(w, 7); frame[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, frame, Buffer.alloc(pad, 1), Buffer.from([0xff, 0xd9])]);
}

export function webpBytes(kind: 'VP8X' | 'VP8L' | 'VP8 ', w = 640, h = 480, pad = 64): Buffer {
  const b = Buffer.alloc(40 + pad);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WEBP', 8, 'ascii');
  b.write(kind, 12, 'ascii');
  if (kind === 'VP8X') {
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
  } else if (kind === 'VP8L') {
    b[20] = 0x2f;
    b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  } else {
    b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a;
    b.writeUInt16LE(w, 26);
    b.writeUInt16LE(h, 28);
  }
  return b;
}

/** A structurally valid JPEG (real signature + frame header with dimensions) of exactly `totalBytes` bytes. */
export function jpegOfExactSize(totalBytes: number, w = 1568, h = 1000): Buffer {
  const base = jpegBytes(w, h, 0).length; // header + trailer with no padding
  if (totalBytes < base) throw new Error('totalBytes too small for a JPEG');
  const out = jpegBytes(w, h, totalBytes - base);
  if (out.length !== totalBytes) throw new Error(`built ${out.length} bytes, wanted ${totalBytes}`);
  return out;
}
