import sharp from 'sharp';

export const DEFAULT_MAX_LONG_EDGE = 1536;
export const OUTPUT_MIME_TYPE = 'image/jpeg';
export const OUTPUT_QUALITY = 80;
export const OUTPUT_BACKGROUND = '#ffffff';

export async function resizeImageToMaxLongEdge(
  bytes,
  maxLongEdge = DEFAULT_MAX_LONG_EDGE,
  sharpImpl = sharp,
) {
  const buffer = await sharpImpl(bytes)
    .resize({
      width: maxLongEdge,
      height: maxLongEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: OUTPUT_BACKGROUND })
    .jpeg({ quality: OUTPUT_QUALITY })
    .toBuffer();

  return {
    bytes: buffer,
    mimeType: OUTPUT_MIME_TYPE,
  };
}
