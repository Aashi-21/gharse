/**
 * Identifies an image from its actual bytes (never from the filename or the client-declared type)
 * and reads its pixel dimensions from the header. Supports JPEG, PNG and WebP only.
 * Returns null for anything else, including truncated or malformed headers.
 */
export interface ImageInfo {
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  ext: 'jpg' | 'png' | 'webp';
  width: number;
  height: number;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(b: Buffer): ImageInfo | null {
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIG) || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { mime: 'image/png', ext: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpeg(b: Buffer): ImageInfo | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i + 1] === 0xff) i++; // fill bytes
    const marker = b[i + 1];
    if (marker === 0xd9 || marker === 0xda) return null; // end/scan reached without a frame header
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (i + 4 > b.length) return null;
    const len = b.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 9 > b.length) return null;
      return { mime: 'image/jpeg', ext: 'jpg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webp(b: Buffer): ImageInfo | null {
  if (b.length < 30 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('ascii', 12, 16);
  let width: number;
  let height: number;
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    width = b.readUInt16LE(26) & 0x3fff;
    height = b.readUInt16LE(28) & 0x3fff;
  } else if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (chunk === 'VP8X') {
    width = b.readUIntLE(24, 3) + 1;
    height = b.readUIntLE(27, 3) + 1;
  } else return null;
  return { mime: 'image/webp', ext: 'webp', width, height };
}

export function inspectImage(buf: Buffer): ImageInfo | null {
  return png(buf) ?? jpeg(buf) ?? webp(buf);
}

/** Single source of truth for upload limits: the multipart plugin (app.ts) and upload validation both read this. */
export const IMAGE_LIMITS = {
  /** 5 MiB = 5,242,880 bytes, the largest accepted image. */
  maxBytes: 5 * 1024 * 1024,
  /** Claude rejects images larger than this on either side. The browser normally sends <=1568px. */
  maxDimension: 8000,
  minDimension: 32,
} as const;
