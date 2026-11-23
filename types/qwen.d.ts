/** @param {unknown} model */
export function isQwenModel(model: unknown): boolean;
/** @param {string | undefined} value */
export function normalizeQwenSize(value: string | undefined): string;
/** @param {unknown} value */
export function parseQwenSeed(value: unknown): number | undefined;
export function assertQwenConfigured(): {
    url: string;
    tokenFile: string;
};
/**
 * Mutable history record owned by the web job runner.
 * @typedef {{ id: string, imageModel: string, prompt: string, size: string, negative?: string,
 * seed?: number, qwenJobId?: string, status: string, stage?: string,
 * queuePosition?: number | null, startedAt: string }} QwenEntry
 */
/**
 * @param {QwenEntry} entry
 * @param {{ images: string[], outputPath: string, onProgress: () => Promise<void> }} options
 */
export function generateQwenImage(entry: QwenEntry, { images, outputPath, onProgress }: {
    images: string[];
    outputPath: string;
    onProgress: () => Promise<void>;
}): Promise<{
    provider: string;
    responseId: string | undefined;
}>;
export const QWEN_MODEL: "qwen-image-2.1";
export const QWEN_FAST_MODEL: "qwen-image-2.1-fast";
export const KREA_MODEL: "krea2";
export const KREA_FAST_MODEL: "krea2-fast";
export const KREA_ID_MODEL: "krea2-id";
export const MOSS_MODEL: "moss";
/** Image model IDs served by the Mac Qwen service, in the order the web form lists them. */
export const QWEN_MODELS: readonly string[];
export const QWEN_TIMEOUT_MS: number;
export class QwenError extends Error {
    /** @param {string} message @param {number} [status] */
    constructor(message: string, status?: number);
    code: string;
    status: number;
}
/**
 * Mutable history record owned by the web job runner.
 */
export type QwenEntry = {
    id: string;
    imageModel: string;
    prompt: string;
    size: string;
    negative?: string;
    seed?: number;
    qwenJobId?: string;
    status: string;
    stage?: string;
    queuePosition?: number | null;
    startedAt: string;
};
