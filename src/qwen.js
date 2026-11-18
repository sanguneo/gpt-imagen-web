import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export const QWEN_MODEL = 'qwen-image-2.1';
export const QWEN_FAST_MODEL = 'qwen-image-2.1-fast';
/** Image model IDs served by the Mac Qwen service, in the order the web form lists them. */
export const QWEN_MODELS = Object.freeze([QWEN_MODEL, QWEN_FAST_MODEL]);
export const QWEN_TIMEOUT_MS = Math.max(120 * 60_000, Number(process.env.QWEN_JOB_TIMEOUT_MS) || 125 * 60_000);

export class QwenError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 502) {
    super(message);
    this.name = 'QwenError';
    this.code = 'QWEN_SERVICE_ERROR';
    this.status = status;
  }
}

/** @param {unknown} model */
export function isQwenModel(model) {
  return QWEN_MODELS.some((id) => id === model);
}

/** @param {string | undefined} value */
export function normalizeQwenSize(value) {
  const size = value === 'auto' || !value ? '1024x1024' : value;
  if (!/^\d{3,4}x\d{3,4}$/.test(size) ||
      !size.split('x').map(Number).every((n) => n >= 256 && n <= 2048 && n % 32 === 0)) {
    throw new QwenError('Qwen 크기는 각 변 256~2048, 32의 배수여야 합니다.', 400);
  }
  return size;
}

/** @param {unknown} value */
export function parseQwenSeed(value) {
  if (value === undefined || value === '') return undefined;
  const seed = Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new QwenError('시드는 0 이상의 안전한 정수여야 합니다.', 400);
  return seed;
}

export function assertQwenConfigured() {
  const url = process.env.QWEN_SERVICE_URL;
  const tokenFile = process.env.QWEN_SERVICE_TOKEN_FILE;
  if (!url || !tokenFile) {
    throw new QwenError('맥 Qwen 서비스 주소와 토큰 파일이 설정되지 않았습니다.', 503);
  }
  return { url, tokenFile };
}

/** @param {string} route @param {RequestInit} [options] */
async function qwenRequest(route, options = {}) {
  const { url, tokenFile } = assertQwenConfigured();
  const token = (await fs.readFile(tokenFile, 'utf8')).trim();
  const response = await fetch(`${url.replace(/\/$/, '')}${route}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
    redirect: 'error'
  });
  if (!response.ok) {
    // Never include upstream bodies or request headers in user-visible errors.
    throw new QwenError(`맥 Qwen 서비스 요청 실패 (HTTP ${response.status}).`);
  }
  return response;
}

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
export async function generateQwenImage(entry, { images, outputPath, onProgress }) {
  if (!entry.qwenJobId) {
    const form = new FormData();
    form.set('requestId', entry.id);
    form.set('prompt', entry.prompt);
    form.set('size', normalizeQwenSize(entry.size));
    form.set('negative', entry.negative || '');
    // The persisted model decides the mode, so a resubmission after a restart stays on the same path.
    form.set('mode', entry.imageModel === QWEN_FAST_MODEL ? 'fast' : 'normal');
    if (entry.seed !== undefined) form.set('seed', String(entry.seed));
    for (const [index, image] of images.entries()) {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(image);
      if (!match) throw new QwenError('참조 이미지 데이터를 읽을 수 없습니다.', 400);
      const extension = match[1].split('/')[1].replace('jpeg', 'jpg');
      form.append('images', new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }), `ref-${index}.${extension}`);
    }
    const submitted = await (await qwenRequest('/jobs', { method: 'POST', body: form })).json();
    if (typeof submitted.id !== 'string' || !/^[a-f0-9-]{20,36}$/.test(submitted.id)) {
      throw new QwenError('맥 Qwen 서비스가 잘못된 작업 ID를 반환했습니다.');
    }
    entry.qwenJobId = submitted.id;
    await onProgress();
  }
  // Queue time is separate from the two-hour generation budget.
  while (true) {
    const job = await (await qwenRequest(`/jobs/${entry.qwenJobId}`)).json();
    if (job.startedAt) entry.startedAt = job.startedAt;
    switch (job.status) {
      case 'queued':
      case 'running':
        entry.status = job.status;
        entry.stage = typeof job.stage === 'string' ? job.stage : job.status;
        entry.queuePosition = Number.isInteger(job.queuePosition) ? job.queuePosition : null;
        await onProgress();
        if (job.status === 'running' && Date.now() - Date.parse(entry.startedAt) > QWEN_TIMEOUT_MS) {
          throw new QwenError('맥 Qwen 생성 시간이 2시간 제한을 초과했습니다.', 504);
        }
        await delay(5000);
        break;
      case 'done': {
        const response = await qwenRequest(`/jobs/${entry.qwenJobId}/image`);
        const image = Buffer.from(await response.arrayBuffer());
        if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          throw new QwenError('맥 Qwen 결과가 PNG 이미지가 아닙니다.');
        }
        await fs.writeFile(outputPath, image);
        entry.stage = '완료';
        entry.queuePosition = 0;
        return { provider: 'qwen-local', responseId: entry.qwenJobId };
      }
      case 'error':
        throw new QwenError(typeof job.error === 'string' ? job.error : '맥 Qwen 이미지 생성이 실패했습니다.');
      default:
        throw new QwenError('맥 Qwen 서비스가 알 수 없는 작업 상태를 반환했습니다.');
    }
  }
}
