// @ts-nocheck
import fs from 'node:fs/promises';
import path from 'node:path';

function assertStandardBase64(value) {
  if (/^data:/i.test(value)) {
    const error = new Error('Expected raw base64 PNG bytes, not a data URL.');
    error.code = 'UNSUPPORTED_DATA_URL';
    throw error;
  }

  if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) {
    const error = new Error('Image payload is not standard base64.');
    error.code = 'INVALID_BASE64';
    throw error;
  }
}

function readPngDimensions(bytes) {
  const signature = '89504e470d0a1a0a';
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== signature || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
    const error = new Error('Decoded image payload is not a valid PNG header.');
    error.code = 'INVALID_PNG';
    throw error;
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  };
}

/**
 * Decode a base64 PNG payload and save it to disk.
 *
 * @param {{ resultBase64: string, outputPath: string, expectedSize?: string, strictSize?: boolean, warnings?: string[] }} options - Base64 image payload, destination path, optional expected dimensions; with strictSize false a mismatch is pushed to warnings instead of thrown.
 * @returns {Promise<string>} The written output path.
 */
export async function saveImage({ resultBase64, outputPath, expectedSize, strictSize = true, warnings }) {
  assertStandardBase64(resultBase64);

  const bytes = Buffer.from(resultBase64.trim(), 'base64');
  if (!bytes.length) {
    const error = new Error('Decoded image payload is empty.');
    error.code = 'EMPTY_IMAGE_PAYLOAD';
    throw error;
  }

  const dimensions = readPngDimensions(bytes);
  if (expectedSize) {
    const actualSize = `${dimensions.width}x${dimensions.height}`;
    if (actualSize !== expectedSize && !strictSize) {
      warnings?.push(`Image size mismatch: requested ${expectedSize}, received ${actualSize}.`);
    } else if (actualSize !== expectedSize) {
      const error = new Error(`Image size mismatch: requested ${expectedSize}, received ${actualSize}.`);
      error.code = 'IMAGE_SIZE_MISMATCH';
      error.expectedSize = expectedSize;
      error.actualSize = actualSize;
      throw error;
    }
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, bytes);
  return outputPath;
}
