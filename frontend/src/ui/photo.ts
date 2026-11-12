// Photo resize before upload (R35): at most 1600 px on the long edge, JPEG quality 0.7 (about
// 200–400 KB). Used by the driver result form and the office Result dialog. A signature is a PNG from
// a canvas (canvasToPng). The server caps: jpg 2 MB, png 300 KB.
export const PHOTO_MAX_EDGE = 1600;
export const PHOTO_QUALITY = 0.7;
export const MAX_JPEG_BYTES = 2_000_000;
export const MAX_PNG_BYTES = 300_000;

/** Size that fits within maxEdge on the long side, keeping the aspect ratio; never upscales. */
export function fitWithin(width: number, height: number, maxEdge = PHOTO_MAX_EDGE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge || long === 0) return { width, height };
  const k = maxEdge / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      // 'from-image' applies the EXIF orientation of phone photos.
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch {
      /* fall back to <img> below (older Safari) */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), type, quality),
  );
}

/**
 * Resizes a camera photo to a JPEG Blob within PHOTO_MAX_EDGE at PHOTO_QUALITY. If the result is still
 * above the server's 2 MB cap (very rare), it retries smaller and at a lower quality.
 */
export async function resizePhoto(file: Blob, maxEdge = PHOTO_MAX_EDGE, quality = PHOTO_QUALITY): Promise<Blob> {
  const img = await decode(file);
  try {
    let edge = maxEdge;
    let q = quality;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { width, height } = fitWithin(img.width, img.height, edge);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('No 2D canvas');
      ctx.fillStyle = '#fff'; // transparent PNG input -> white, not black
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img.source, 0, 0, width, height);
      const blob = await toBlob(canvas, 'image/jpeg', q);
      if (blob.size <= MAX_JPEG_BYTES) return blob;
      edge = Math.round(edge * 0.75);
      q = Math.max(0.4, q - 0.1);
    }
    throw new Error('Photo too large after resizing');
  } finally {
    img.close();
  }
}

/** A signature canvas as a PNG Blob. */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return toBlob(canvas, 'image/png');
}
