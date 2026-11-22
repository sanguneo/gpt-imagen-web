// @ts-nocheck
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';
import { KREA_FAST_MODEL, KREA_MODEL, QWEN_MODEL, QWEN_MODELS, QWEN_TIMEOUT_MS, assertQwenConfigured, generateQwenImage, isQwenModel, normalizeQwenSize, parseQwenSeed } from './qwen.js';

import {
  CODEX_MODEL_CHOICES,
  DEFAULT_CODEX_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_SIZE,
  IMAGE_MODEL_CHOICES,
  createProvider,
  normalizeImageSize,
  resolveConfig
} from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'web', 'public');
const dataDir = process.env.IMAGEN_DATA_DIR || path.join(root, 'var');
const outputDir = path.join(dataDir, 'outputs');
const uploadDir = path.join(dataDir, 'uploads');
const inputDir = path.join(dataDir, 'inputs');
const historyDir = path.join(dataDir, 'history');
const debugDir = path.join(dataDir, 'debug');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const providerName = process.env.IMAGEN_PROVIDER || process.env.CODEX_IMAGEGEN_PROVIDER || 'private-codex';
// IPMPT runs beside Imagen. Keep this integration on loopback rather than sending
// its API/image-copy traffic through a public domain and back to this host.
const ipmptOrigin = (process.env.IPMPT_LOCAL_ORIGIN || 'http://127.0.0.1:8791').replace(/\/$/, '');
const ALLOWED_MODELS = CODEX_MODEL_CHOICES;
const webImageModels = [...IMAGE_MODEL_CHOICES, ...QWEN_MODELS];
const defaultModel = process.env.IMAGEN_MODEL || process.env.CODEX_IMAGEGEN_MODEL || process.env.CODEX_MODEL || DEFAULT_CODEX_MODEL;
const model = ALLOWED_MODELS.includes(defaultModel) ? defaultModel : DEFAULT_CODEX_MODEL;
function resolveStoredModel(value) {
  const candidate = cleanText(value, 32);
  return ALLOWED_MODELS.includes(candidate) ? candidate : model;
}
function resolveRequestedModel(value) {
  const candidate = cleanText(value, 32);
  if (!candidate) return model;
  if (ALLOWED_MODELS.includes(candidate)) return candidate;
  const error = new Error(`지원하지 않는 모델입니다: ${candidate}`);
  error.code = 'INVALID_CODEX_MODEL';
  error.status = 400;
  throw error;
}
function resolveStoredImageModel(value) {
  const candidate = cleanText(value, 40);
  return webImageModels.includes(candidate) ? candidate : DEFAULT_IMAGE_MODEL;
}
function resolveRequestedImageModel(value) {
  const candidate = cleanText(value, 40);
  if (!candidate) return DEFAULT_IMAGE_MODEL;
  if (webImageModels.includes(candidate)) return candidate;
  const error = new Error(`지원하지 않는 이미지 모델입니다: ${candidate}`);
  error.code = 'INVALID_IMAGE_MODEL';
  error.status = 400;
  throw error;
}
function resolveRequestedSize(value) {
  try {
    return normalizeImageSize(cleanText(value, 32) || DEFAULT_IMAGE_SIZE) || DEFAULT_IMAGE_SIZE;
  } catch (error) {
    error.status = 400;
    throw error;
  }
}
const maxImages = Number(process.env.IMAGEN_MAX_IMAGES || 4);
const maxImageBytes = Number(process.env.IMAGEN_MAX_IMAGE_BYTES || 12 * 1024 * 1024);
const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const generationTimeoutMs = Number(process.env.IMAGEN_TIMEOUT_MS || 600_000);
const maxPromptChars = Number(process.env.IMAGEN_MAX_PROMPT_CHARS || 60_000);
const maxConcurrent = Number(process.env.IMAGEN_MAX_CONCURRENT || 3);
const ID_PATTERN = /^[a-f0-9]{20}$/;

await Promise.all([
  fs.mkdir(outputDir, { recursive: true }),
  fs.mkdir(uploadDir, { recursive: true }),
  fs.mkdir(inputDir, { recursive: true }),
  fs.mkdir(historyDir, { recursive: true }),
  fs.mkdir(debugDir, { recursive: true })
]);

const app = express();
const upload = multer({ dest: uploadDir, limits: { files: maxImages, fileSize: maxImageBytes } });
const runningJobs = new Map();
const qwenJobs = new Map();
const pendingQueue = [];

function isActiveJob(id) {
  return runningJobs.has(id) || qwenJobs.has(id) || pendingQueue.some((job) => job.entry.id === id);
}
function pumpQueue() {
  while (runningJobs.size < maxConcurrent && pendingQueue.length > 0) {
    const { entry, images } = pendingQueue.shift();
    const promise = runGeneration(entry, { images });
    runningJobs.set(entry.id, promise);
    promise.catch(() => {});
  }
}
function enqueueGeneration(entry, images) {
  if (isQwenModel(entry.imageModel)) {
    const promise = runGeneration(entry, { images });
    qwenJobs.set(entry.id, promise);
    return;
  }
  pendingQueue.push({ entry, images });
  pumpQueue();
}

app.use(express.json({ limit: '64kb' }));
app.use(express.static(publicDir, { etag: true, maxAge: 0 }));
app.use('/outputs', express.static(outputDir, { etag: true, maxAge: '365d', immutable: true }));

async function proxyIpmpt(req, res, { prefix = '/api' } = {}) {
  const headers = {};
  if (req.headers.accept) headers.accept = req.headers.accept;
  let body;
  if (!['GET', 'HEAD'].includes(req.method)) {
    headers['content-type'] = 'application/json';
    const payload = { ...(req.body || {}) };
    // Imagen outputs are local files. IPMPT fetches this loopback URL when making
    // its own durable copy, avoiding a public DNS/TLS/network round-trip as well.
    if (prefix === '/api' && /^\/import\/(new|add)(?:\?|$)/.test(req.url) && typeof payload.imageUrl === 'string' && payload.imageUrl.startsWith('/outputs/')) {
      payload.imageUrl = `http://127.0.0.1:${port}${payload.imageUrl}`;
    }
    body = JSON.stringify(payload);
  }
  try {
    const upstream = await fetch(`${ipmptOrigin}${prefix}${req.url}`, { method: req.method, headers, body });
    const responseHeaders = {};
    for (const name of ['content-type', 'cache-control']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    res.status(upstream.status).set(responseHeaders).send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    res.status(502).json({ ok: false, error: `IPMPT 로컬 연결 실패: ${error.message}` });
  }
}

// The browser uses Imagen's same origin; only the two services communicate here.
// This also makes the IPMPT public-domain rename irrelevant to Imagen.
app.use('/api/ipmpt', (req, res) => proxyIpmpt(req, res));
app.use('/ipmpt-images', (req, res) => proxyIpmpt(req, res, { prefix: '/images' }));

function nowIso() { return new Date().toISOString(); }
function makeId(bytes = 10) { return crypto.randomBytes(bytes).toString('hex'); }
function cleanText(value, max = 8000) { return String(value || '').trim().slice(0, max); }
function cleanPrompt(value) {
  const prompt = String(value || '').trim();
  if (prompt.length > maxPromptChars) {
    const error = new Error(`프롬프트가 너무 깁니다. 현재 ${prompt.length.toLocaleString('ko-KR')}자 / 최대 ${maxPromptChars.toLocaleString('ko-KR')}자`);
    error.status = 413;
    throw error;
  }
  return prompt;
}
function historyPath(id) { return path.join(historyDir, `${id}.json`); }
async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function readHistory(id) { return readJson(historyPath(id)); }
async function removePath(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
}
async function writeHistory(entry) {
  entry.updatedAt = nowIso();
  const target = historyPath(entry.id);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entry, null, 2));
  await fs.rename(tmp, target);
}
function publicEntry(entry, { fullPrompt = true } = {}) {
  const out = {
    id: entry.id,
    status: entry.status,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    startedAt: entry.startedAt || null,
    finishedAt: entry.finishedAt || null,
    promptPreview: String(entry.prompt || '').slice(0, 180),
    size: entry.size || 'auto',
    model: isQwenModel(entry.imageModel) ? null : resolveStoredModel(entry.model),
    imageModel: resolveStoredImageModel(entry.imageModel),
    stage: entry.stage || null,
    queuePosition: entry.queuePosition ?? null,
    // Only the normal model has measured timings.
    estimatedTime: entry.imageModel === QWEN_MODEL ? '512×512 약 7분 · 1024×1024 약 28분 · 참조·크기에 따라 1시간 이상, 생성 제한 2시간' : null,
    negative: entry.negative || '',
    seed: entry.seed ?? null,
    imageCount: entry.imageCount || 0,
    imageUrl: entry.imageUrl || null,
    error: entry.error || null,
    errorCode: entry.errorCode || null,
    errorDetails: entry.errorDetails || null,
    debugUrl: entry.debugUrl || null,
    provider: entry.provider || providerName,
    responseId: entry.responseId || null,
    responsePrompt: entry.revisedPrompt || entry.responsePrompt || null,
    revisedPrompt: entry.revisedPrompt || null,
    warnings: entry.warnings || [],
    retryOf: entry.retryOf || null,
    elapsedMs: entry.elapsedMs || (entry.startedAt && entry.status === 'running' ? Date.now() - Date.parse(entry.startedAt) : null)
  };
  if (fullPrompt) out.prompt = entry.prompt;
  return out;
}
async function listHistory({ page = 1, pageSize = 20 } = {}) {
  const files = (await fs.readdir(historyDir).catch(() => [])).filter((x) => x.endsWith('.json'));
  const entries = [];
  for (const file of files) {
    const id = file.slice(0, -5);
    if (!ID_PATTERN.test(id)) continue;
    const entry = await readHistory(id).catch(() => null);
    if (entry) entries.push(publicEntry(await expireTimedOutEntry(entry), { fullPrompt: false }));
  }
  entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const total = entries.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.max(1, Math.min(totalPages, page));
  const start = (safePage - 1) * pageSize;
  return {
    history: entries.slice(start, start + pageSize),
    pagination: { page: safePage, pageSize, total, totalPages, hasPrev: safePage > 1, hasNext: safePage < totalPages }
  };
}
async function readUpload(file) {
  if (!allowedTypes.has(file.mimetype)) {
    const error = new Error(`지원하지 않는 이미지 형식입니다: ${file.originalname || file.mimetype}`);
    error.status = 400;
    throw error;
  }
  const buffer = await fs.readFile(file.path);
  return { mimetype: file.mimetype, buffer };
}
function extensionForMime(mimetype) {
  return ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' })[mimetype] || '.img';
}
async function persistInputImages(jobId, uploads) {
  if (uploads.length === 0) return [];
  const dir = path.join(inputDir, jobId);
  await fs.mkdir(dir, { recursive: true });
  const saved = [];
  for (const [index, upload] of uploads.entries()) {
    const fileName = `${String(index + 1).padStart(2, '0')}${extensionForMime(upload.mimetype)}`;
    const relativePath = `${jobId}/${fileName}`;
    await fs.writeFile(path.join(inputDir, relativePath), upload.buffer);
    saved.push({ mimetype: upload.mimetype, path: relativePath });
  }
  return saved;
}
async function loadInputImages(inputImages = []) {
  const images = [];
  for (const item of inputImages) {
    if (!item?.path || !item?.mimetype) continue;
    const buffer = await fs.readFile(path.join(inputDir, item.path));
    images.push(`data:${item.mimetype};base64,${buffer.toString('base64')}`);
  }
  return images;
}
async function copyInputImages(sourceImages = [], targetJobId) {
  if (sourceImages.length === 0) return [];
  const targetDir = path.join(inputDir, targetJobId);
  await fs.mkdir(targetDir, { recursive: true });
  const copied = [];
  for (const [index, item] of sourceImages.entries()) {
    if (!item?.path || !item?.mimetype) continue;
    const ext = extensionForMime(item.mimetype);
    const fileName = `${String(index + 1).padStart(2, '0')}${ext}`;
    const relativePath = `${targetJobId}/${fileName}`;
    await fs.copyFile(path.join(inputDir, item.path), path.join(inputDir, relativePath));
    copied.push({ mimetype: item.mimetype, path: relativePath });
  }
  return copied;
}
function assertExists(entry) {
  if (!entry) {
    const error = new Error('히스토리를 찾을 수 없습니다.');
    error.status = 404;
    throw error;
  }
}
function timeoutError() {
  const error = new Error(`이미지 생성 요청이 ${Math.round(generationTimeoutMs / 1000)}초를 초과해 만료되었습니다.`);
  error.code = 'GENERATION_TIMEOUT';
  return error;
}
function interruptedError() {
  const error = new Error('서버가 재시작되어 진행 중이던 작업이 중단되었습니다. 다시 시도하세요.');
  error.code = 'SERVER_RESTART';
  return error;
}
function markEntryError(entry, error) {
  entry.status = 'error';
  entry.finishedAt = nowIso();
  entry.errorCode = error.code || null;
  entry.error = error.message;
  entry.errorDetails = { name: error.name || 'Error', code: error.code || null, status: error.status || null, body: null, cause: null };
  entry.debugUrl = `/api/history/${entry.id}/debug`;
  const base = Date.parse(entry.startedAt || entry.createdAt || entry.updatedAt || '');
  entry.elapsedMs = Number.isFinite(base) ? Date.now() - base : generationTimeoutMs;
}
function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(timeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}
function isTimedOutEntry(entry) {
  if (!entry || !['queued', 'running'].includes(entry.status)) return false;
  if (isActiveJob(entry.id)) return false;
  const base = Date.parse(entry.startedAt || entry.createdAt || entry.updatedAt || '');
  return Number.isFinite(base) && Date.now() - base > (isQwenModel(entry.imageModel) ? QWEN_TIMEOUT_MS : generationTimeoutMs);
}
async function expireTimedOutEntry(entry) {
  if (!isTimedOutEntry(entry)) return entry;
  markEntryError(entry, timeoutError());
  await writeHistory(entry).catch(() => {});
  return entry;
}
async function failInterruptedJobsOnBoot() {
  // On boot no generation job can be alive, so any entry still marked queued/running
  // was interrupted by the previous process exit. Fail it immediately instead of
  // letting it linger as "생성중" until the timeout window elapses.
  const files = (await fs.readdir(historyDir).catch(() => [])).filter((x) => x.endsWith('.json'));
  const error = interruptedError();
  await Promise.all(files.map(async (file) => {
    const id = file.slice(0, -5);
    if (!ID_PATTERN.test(id)) return;
    const entry = await readHistory(id).catch(() => null);
    if (!entry || !['queued', 'running'].includes(entry.status)) return;
    if (isQwenModel(entry.imageModel)) {
      // The Mac owns execution. The stable request ID makes resubmission idempotent
      // even if this process exited before the remote ID was saved.
      enqueueGeneration(entry, await loadInputImages(entry.inputImages || []));
      return;
    }
    markEntryError(entry, error);
    await writeHistory(entry).catch(() => {});
  }));
}

await failInterruptedJobsOnBoot();

async function runGeneration(entry, { images }) {
  const started = Date.now();
  const isQwen = isQwenModel(entry.imageModel);
  entry.status = 'running';
  if (!isQwen || !entry.startedAt) entry.startedAt = new Date(started).toISOString();
  await writeHistory(entry);

  try {
    const outputPath = path.join(outputDir, `${entry.id}.png`);
    const entryDebugDir = path.join(debugDir, entry.id);
    let result;
    if (isQwen) {
      result = await generateQwenImage(entry, { images, outputPath, onProgress: () => writeHistory(entry) });
    } else {
      const provider = createProvider(resolveConfig({ provider: providerName }));
      result = await withTimeout(provider.generateImage({
      prompt: entry.prompt,
      model: resolveStoredModel(entry.model),
      imageModel: resolveStoredImageModel(entry.imageModel),
      outputPath,
      images,
      size: normalizeImageSize(entry.size),
      strictSize: false,
      dryRun: false,
      debug: true,
      debugDir: entryDebugDir
    }), generationTimeoutMs);
    }

    entry.status = 'done';
    entry.finishedAt = nowIso();
    entry.imageUrl = `/outputs/${entry.id}.png`;
    entry.provider = result.provider || providerName;
    entry.responseId = result.responseId || null;
    entry.revisedPrompt = result.revisedPrompt || result.response?.lastMessage || null;
    entry.responsePrompt = entry.revisedPrompt;
    entry.warnings = result.warnings || [];
    entry.elapsedMs = isQwen
      ? Date.parse(entry.finishedAt) - Date.parse(entry.startedAt)
      : Date.now() - started;
    await writeHistory(entry);
  } catch (error) {
    entry.status = 'error';
    entry.finishedAt = nowIso();
    entry.errorCode = error.code || null;
    entry.debugUrl = `/api/history/${entry.id}/debug`;
    entry.error = error.code === 'MISSING_IMAGE_GENERATION_OUTPUT'
      ? '이미지 결과가 반환되지 않았습니다. 프롬프트를 더 짧고 명확하게 바꿔 다시 시도하세요.'
      : (error.message || '이미지 생성 실패');
    entry.errorDetails = {
      name: error.name || null,
      code: error.code || null,
      status: error.status || null,
      body: error.body ? String(error.body).slice(0, 4000) : null,
      cause: error.cause?.message || null
    };
    entry.elapsedMs = isQwen
      ? Date.parse(entry.finishedAt) - Date.parse(entry.startedAt)
      : Date.now() - started;
    await writeHistory(entry).catch(() => {});
  } finally {
    runningJobs.delete(entry.id);
    qwenJobs.delete(entry.id);
    pumpQueue();
  }
}

app.get('/healthz', (req, res) => res.json({ ok: true, engine: 'node', mode: 'background-jobs', provider: providerName, model, models: ALLOWED_MODELS, imageModel: DEFAULT_IMAGE_MODEL, imageModels: webImageModels, running: runningJobs.size, queued: pendingQueue.length, maxConcurrent, generationTimeoutMs, qwenRunning: qwenJobs.size, qwenTimeoutMs: QWEN_TIMEOUT_MS }));

app.post('/api/generate', upload.array('images', maxImages), async (req, res) => {
  const files = req.files || [];
  const id = makeId();
  try {
    const body = req.body || {};
    const prompt = cleanPrompt(body.prompt);
    const requestedImageModel = resolveRequestedImageModel(body.imageModel);
    if ((requestedImageModel === KREA_MODEL || requestedImageModel === KREA_FAST_MODEL) && files.length > 0) {
      return res.status(400).json({ ok: false, error: 'Krea 2는 텍스트만 지원하며 참고 이미지를 첨부할 수 없습니다.' });
    }
    const isQwen = isQwenModel(requestedImageModel);
    if (isQwen) assertQwenConfigured();
    const size = isQwen ? normalizeQwenSize(body.size) : resolveRequestedSize(body.size);
    const requestedModel = isQwen ? null : resolveRequestedModel(body.model);
    const negative = isQwen ? cleanPrompt(body.negative) : '';
    const seed = isQwen ? parseQwenSeed(body.seed) : undefined;
    if (!prompt) return res.status(400).json({ ok: false, error: '프롬프트를 입력하세요.' });

    const uploads = [];
    for (const file of files) uploads.push(await readUpload(file));
    const inputImages = await persistInputImages(id, uploads);
    const images = await loadInputImages(inputImages);
    const createdAt = nowIso();
    const entry = {
      id,
      status: 'queued',
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      prompt,
      size,
      model: requestedModel,
      imageModel: requestedImageModel,
      negative,
      ...(seed === undefined ? {} : { seed }),
      imageCount: uploads.length,
      inputImages,
      imageUrl: null,
      error: null,
      errorCode: null,
      errorDetails: null,
      debugUrl: null,
      provider: isQwen ? 'qwen-local' : providerName,
      responseId: null,
      revisedPrompt: null,
      responsePrompt: null,
      warnings: [],
      elapsedMs: null
    };
    await writeHistory(entry);
    enqueueGeneration(entry, images);
    res.status(202).json({ ok: true, entry: publicEntry(entry) });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, id, error: error.message || '이미지 생성 시작 실패' });
  } finally {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
  }
});

app.get('/api/history', async (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1) || 1);
  const result = await listHistory({ page, pageSize: 20 });
  res.json({ ok: true, ...result });
});

app.get('/api/history/:id', async (req, res) => {
  const { id } = req.params;
  if (!ID_PATTERN.test(id)) return res.status(400).json({ ok: false, error: '잘못된 히스토리 ID입니다.' });
  try {
    const entry = await expireTimedOutEntry(await readHistory(id));
    assertExists(entry);
    res.json({ ok: true, entry: publicEntry(entry) });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message });
  }
});

app.post('/api/history/:id/retry', async (req, res) => {
  const { id: sourceId } = req.params;
  if (!ID_PATTERN.test(sourceId)) return res.status(400).json({ ok: false, error: '잘못된 히스토리 ID입니다.' });
  try {
    const source = await expireTimedOutEntry(await readHistory(sourceId));
    assertExists(source);
    if (source.status !== 'error') return res.status(400).json({ ok: false, error: '실패한 작업만 재시도할 수 있습니다.' });

    const id = makeId();
    const inputImages = await copyInputImages(source.inputImages || [], id);
    const images = await loadInputImages(inputImages);
    if ((source.imageCount || 0) > 0 && inputImages.length === 0) {
      return res.status(409).json({ ok: false, error: '원본 참고이미지를 찾을 수 없어 재시도할 수 없습니다.' });
    }
    const createdAt = nowIso();
    const entry = {
      id,
      status: 'queued',
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      prompt: source.prompt,
      size: source.size || 'auto',
      model: isQwenModel(source.imageModel) ? null : resolveStoredModel(source.model),
      imageModel: resolveStoredImageModel(source.imageModel),
      negative: source.negative || '',
      ...(source.seed === undefined ? {} : { seed: source.seed }),
      imageCount: inputImages.length,
      inputImages,
      imageUrl: null,
      error: null,
      errorCode: null,
      errorDetails: null,
      debugUrl: null,
      provider: isQwenModel(source.imageModel) ? 'qwen-local' : providerName,
      responseId: null,
      revisedPrompt: null,
      responsePrompt: null,
      warnings: inputImages.length ? ['원본 참고이미지를 포함해 재시도했습니다.'] : [],
      elapsedMs: null,
      retryOf: sourceId
    };
    await writeHistory(entry);
    enqueueGeneration(entry, images);
    res.status(202).json({ ok: true, entry: publicEntry(entry) });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message || '재시도 시작 실패' });
  }
});

app.delete('/api/history/:id', async (req, res) => {
  const { id } = req.params;
  if (!ID_PATTERN.test(id)) return res.status(400).json({ ok: false, error: '잘못된 히스토리 ID입니다.' });
  try {
    const entry = await expireTimedOutEntry(await readHistory(id));
    assertExists(entry);
    if (entry.status === 'queued' || entry.status === 'running' || isActiveJob(id)) {
      return res.status(409).json({ ok: false, error: '생성중인 작업은 삭제할 수 없습니다.' });
    }
    await Promise.all([
      removePath(historyPath(id)),
      removePath(path.join(outputDir, `${id}.png`)),
      removePath(path.join(debugDir, id)),
      removePath(path.join(inputDir, id))
    ]);
    res.json({ ok: true, deleted: id });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message || '삭제 실패' });
  }
});

app.get('/api/history/:id/debug', async (req, res) => {
  const { id } = req.params;
  if (!ID_PATTERN.test(id)) return res.status(400).json({ ok: false, error: '잘못된 히스토리 ID입니다.' });
  try {
    const entry = await expireTimedOutEntry(await readHistory(id));
    assertExists(entry);
    const [responseDebug, requestDebug, cliDebug] = await Promise.all([
      readJson(path.join(debugDir, id, 'response.json')),
      readJson(path.join(debugDir, id, 'request.json')),
      readJson(path.join(debugDir, id, 'codex-cli-run.json'))
    ]);
    if (!responseDebug && !requestDebug && !cliDebug) return res.status(404).json({ ok: false, error: '디버그 정보가 없습니다.' });
    res.json({ ok: true, request: requestDebug, response: responseDebug, cli: cliDebug });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message || '디버그 정보 조회 실패' });
  }
});

// JSON error handler — without this, multer errors (oversized/too many files) and any
// other thrown middleware error return an HTML 500, which the frontend can only show as
// "HTTP 500". Must stay last, after all routes, and keep 4 args so Express treats it as
// error-handling middleware.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: `이미지 크기가 최대 ${Math.round(maxImageBytes / (1024 * 1024))}MB를 초과했습니다.`,
      LIMIT_FILE_COUNT: `이미지는 최대 ${maxImages}개까지 첨부할 수 있습니다.`,
      LIMIT_UNEXPECTED_FILE: '허용되지 않은 파일 필드입니다.'
    };
    return res.status(400).json({ ok: false, error: messages[err.code] || `이미지 업로드 오류: ${err.message}` });
  }
  return res.status(err?.status || 500).json({ ok: false, error: err?.message || '서버 오류가 발생했습니다.' });
});

export function startWebServer() {
  return app.listen(port, host, () => console.log(`imagen web listening on http://${host}:${port} with node background jobs`));
}

export { app };
export const webServerInternals = {
  resolveRequestedModel,
  resolveRequestedImageModel,
  resolveRequestedSize,
  resolveStoredModel
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startWebServer();
}
