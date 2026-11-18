// @ts-nocheck

export const DEFAULT_IMAGE_SIZE = 'auto';
const EXPERIMENTAL_IMAGE_PIXELS = 2560 * 1440;

// The public Images API accepts additional constrained sizes, but the private
// Codex image_generation tool currently honors only these observed presets.
export const SUPPORTED_IMAGE_SIZES = new Set([
  'auto',
  '1024x1024',
  '1536x1024',
  '1024x1536',
  '2048x2048',
  '2048x1152',
  '3840x2160',
  '2160x3840'
]);

function invalidSize(message) {
  const error = new Error(message);
  error.code = 'INVALID_IMAGE_SIZE';
  return error;
}

/**
 * Normalize and validate a private Codex image_generation output size.
 *
 * @param {string | null | undefined} size - `auto` or a supported preset.
 * @returns {string | undefined} A supported preset, or undefined for auto.
 */
export function normalizeImageSize(size) {
  if (size == null) {
    return undefined;
  }
  if (typeof size !== 'string') {
    throw invalidSize('Image size must be auto or WIDTHxHEIGHT, for example 1024x1024.');
  }

  const normalized = size.trim().toLowerCase();
  if (!normalized || normalized === DEFAULT_IMAGE_SIZE) {
    return undefined;
  }

  if (!SUPPORTED_IMAGE_SIZES.has(normalized)) {
    throw invalidSize(
      `Unsupported private Codex image size: ${normalized}. Supported sizes: ${Array.from(SUPPORTED_IMAGE_SIZES).join(', ')}.`
    );
  }

  return normalized;
}

/**
 * Return non-fatal model guidance for an output size.
 *
 * @param {string | null | undefined} size - `auto` or a supported preset.
 * @returns {string[]} Warning messages for the requested size.
 */
export function getImageSizeWarnings(size) {
  const normalized = normalizeImageSize(size);
  if (!normalized) {
    return [];
  }
  const [width, height] = normalized.split('x').map(Number);
  if (width * height > EXPERIMENTAL_IMAGE_PIXELS) {
    return [`Image size ${normalized} is experimental because it exceeds 2560x1440 total pixels.`];
  }
  return [];
}
