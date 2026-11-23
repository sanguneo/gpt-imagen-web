/**
 * Decode a base64 PNG payload and save it to disk.
 *
 * @param {{ resultBase64: string, outputPath: string, expectedSize?: string, strictSize?: boolean, warnings?: string[] }} options - Base64 image payload, destination path, optional expected dimensions; with strictSize false a mismatch is pushed to warnings instead of thrown.
 * @returns {Promise<string>} The written output path.
 */
export function saveImage({ resultBase64, outputPath, expectedSize, strictSize, warnings }: {
    resultBase64: string;
    outputPath: string;
    expectedSize?: string;
    strictSize?: boolean;
    warnings?: string[];
}): Promise<string>;
