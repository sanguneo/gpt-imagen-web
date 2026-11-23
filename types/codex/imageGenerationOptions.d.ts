/**
 * Normalize and validate a private Codex image_generation output size.
 *
 * @param {string | null | undefined} size - `auto` or a supported preset.
 * @returns {string | undefined} A supported preset, or undefined for auto.
 */
export function normalizeImageSize(size: string | null | undefined): string | undefined;
/**
 * Return non-fatal model guidance for an output size.
 *
 * @param {string | null | undefined} size - `auto` or a supported preset.
 * @returns {string[]} Warning messages for the requested size.
 */
export function getImageSizeWarnings(size: string | null | undefined): string[];
export const DEFAULT_IMAGE_SIZE: "auto";
export const SUPPORTED_IMAGE_SIZES: Set<string>;
