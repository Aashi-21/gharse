export const MAX_DIMENSION = 1568;
/** Largest ORIGINAL photo we will try to decode in the browser (decoding huge files can freeze phones). */
export const MAX_ORIGINAL_BYTES = 30 * 1024 * 1024;
/** Largest resized photo we upload. Keep equal to the server's IMAGE_LIMITS.maxBytes (server/src/lib/imageInfo.ts). */
export const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Shrinks a chosen photo in the browser before upload: longest side <= 1568px, re-encoded as JPEG
 * (transparent areas become white), and under 5 MB. Honours the camera's EXIF orientation.
 * The server independently re-validates everything, so this is for speed and cost, not security.
 */
export async function resizeForUpload(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  if (!ACCEPTED.includes(file.type)) throw new Error('Please choose a JPEG, PNG or WebP photo.');
  if (file.size > MAX_ORIGINAL_BYTES) {
    throw new Error(`That photo is larger than ${MAX_ORIGINAL_BYTES / 1024 / 1024} MB. Please choose a smaller photo, or take it again at a lower resolution.`);
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('We could not read that photo. Please try a different one.');
  }
  let scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  for (let attempt = 0; attempt < 4; attempt++) {
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser could not process the photo.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    for (const quality of [0.88, 0.8, 0.7]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', quality));
      if (blob && blob.size <= MAX_BYTES) {
        bitmap.close();
        return { blob, width, height };
      }
    }
    scale *= 0.75; // still too big: shrink further
  }
  bitmap.close();
  throw new Error('This photo is too large to upload. Please use a smaller one.');
}
