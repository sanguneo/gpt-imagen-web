import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { makeTempDir, PNG_BASE64 } from './helpers.js';
import { normalizeQwenSize, parseQwenSeed } from '../src/qwen.js';

const PNG = Buffer.from(PNG_BASE64, 'base64');
const REMOTE_ID = '11111111-2222-4333-8444-555555555555';
/** A MOSS-Image JSON layout as pasted into the prompt: several lines, Korean text and an escaped line break. */
const MOSS_LAYOUT_PROMPT = JSON.stringify({
  summary: { meta: ['poster'], canvas: 'single', caption: '크림색 배경의 카페 포스터' },
  items: [{ label: 'text', caption: '위쪽 가운데의 큰 제목', text: '까치\n카페', bbox: [-416, -384, -288, 384] }],
  bbox_coord_space: 'abs_centralized',
  bbox_format: 'yxyx'
}, null, 2);

function completedHistory(historyDir, t) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error('Qwen history was not completed')); }, 10_000);
    const watcher = watch(historyDir, async (_, filename) => {
      if (!filename?.endsWith('.json')) return;
      try {
        const entry = JSON.parse(await fs.readFile(path.join(historyDir, filename), 'utf8'));
        if (['done', 'error'].includes(entry.status)) {
          clearTimeout(timer);
          watcher.close();
          resolve(entry);
        }
      } catch (error) {
        clearTimeout(timer);
        watcher.close();
        reject(error);
      }
    });
    t.after(() => { clearTimeout(timer); watcher.close(); });
  });
}

/**
 * Starts a fake Mac service that completes every job, then points the Qwen client
 * and a fresh data directory at it. `submissions` collects each submitted form.
 */
async function startFakeMac(t, { startedAt } = {}) {
  const dir = await makeTempDir('qwen-web-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const submissions = [];
  const mac = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer local-test-token') {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'POST' && req.url === '/jobs') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request('http://mac/jobs', { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) });
      submissions.push(await request.formData());
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: REMOTE_ID }));
    } else if (req.url === `/jobs/${REMOTE_ID}/image`) {
      res.setHeader('Content-Type', 'image/png');
      res.end(PNG);
    } else if (req.url === `/jobs/${REMOTE_ID}`) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: REMOTE_ID, status: 'done', queuePosition: 0, startedAt }));
    } else {
      res.writeHead(404).end();
    }
  });
  mac.listen(0, '127.0.0.1');
  await once(mac, 'listening');
  t.after(() => new Promise((resolve) => mac.close(resolve)));
  process.env.QWEN_SERVICE_URL = `http://127.0.0.1:${mac.address().port}`;
  process.env.QWEN_SERVICE_TOKEN_FILE = path.join(dir, 'test.token');
  process.env.IMAGEN_DATA_DIR = path.join(dir, 'data');
  await fs.writeFile(process.env.QWEN_SERVICE_TOKEN_FILE, 'local-test-token', { mode: 0o600 });
  const historyDir = path.join(process.env.IMAGEN_DATA_DIR, 'history');
  await fs.mkdir(historyDir, { recursive: true });
  return { submissions, historyDir };
}

/** Boots a separate web-server instance; importing it reads the environment and recovers saved jobs. */
async function startWeb(t, instance) {
  const { app } = await import(`../src/web-server.js?${instance}`);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('Qwen rejects unsupported dimensions and seeds at the input boundary', () => {
  assert.equal(normalizeQwenSize('auto'), '1024x1024');
  assert.equal(normalizeQwenSize('512x512'), '512x512');
  for (const size of ['3840x2160', '513x512', '0x512', '512x512x512']) {
    assert.throws(() => normalizeQwenSize(size), { status: 400 });
  }
  for (const seed of ['-1', '1.2', '9007199254740992', 'no']) {
    assert.throws(() => parseQwenSeed(seed), { status: 400 });
  }
  assert.equal(parseQwenSeed('0'), 0);
});

for (const { imageModel, mode, references, prompt = 'a red teapot' } of [
  { imageModel: 'qwen-image-2.1', mode: 'normal', references: 1 },
  { imageModel: 'qwen-image-2.1-fast', mode: 'fast', references: 1 },
  { imageModel: 'krea2', mode: 'krea2', references: 0 },
  { imageModel: 'krea2-fast', mode: 'krea2-fast', references: 0 },
  { imageModel: 'krea2-id', mode: 'krea2-id', references: 1 },
  { imageModel: 'moss', mode: 'moss', references: 0, prompt: MOSS_LAYOUT_PROMPT },
  { imageModel: 'moss', mode: 'moss', references: 4 }
]) {
  test(`web ${imageModel} job submits ${mode} mode ${references ? 'with references' : 'without references'} and saves the remote PNG in history`, async (t) => {
    const { submissions, historyDir } = await startFakeMac(t);
    const origin = await startWeb(t, `create-${mode}-${references}`);
    const completed = completedHistory(historyDir, t);
    // Each reference has its own length, so a dropped or reordered one cannot pass.
    const sent = Array.from({ length: references }, (_, index) => Buffer.concat([PNG, Buffer.alloc(index)]));
    const form = new FormData();
    form.set('prompt', prompt);
    form.set('imageModel', imageModel);
    form.set('size', '512x512');
    form.set('negative', 'text, blurry');
    form.set('seed', '42');
    for (const [index, image] of sent.entries()) form.append('images', new Blob([image], { type: 'image/png' }), `ref-${index}.png`);
    const response = await fetch(`${origin}/api/generate`, { method: 'POST', body: form });
    assert.equal(response.status, 202, `Expected the web server to accept ${imageModel}`);
    const { entry: accepted } = await response.json();
    const done = await completed;
    assert.equal(done.status, 'done');
    assert.equal(done.id, accepted.id);
    assert.equal(done.provider, 'qwen-local');
    assert.equal(submissions.length, 1);
    const [submitted] = submissions;
    assert.equal(submitted.get('requestId'), accepted.id);
    assert.equal(submitted.get('mode'), mode);
    assert.equal(submitted.get('negative'), 'text, blurry');
    assert.equal(submitted.get('seed'), '42');
    assert.equal(submitted.get('size'), '512x512');
    // Multipart carries line breaks as CRLF; apart from that the prompt arrives as written.
    assert.equal(submitted.get('prompt').replaceAll('\r\n', '\n'), prompt);
    const received = await Promise.all(submitted.getAll('images').map(async (file) => Buffer.from(await file.arrayBuffer())));
    assert.deepEqual(received, sent);
    assert.deepEqual(Buffer.from(await (await fetch(origin + done.imageUrl)).arrayBuffer()), PNG);
    const publicHistory = await (await fetch(`${origin}/api/history/${done.id}`)).json();
    assert.equal(publicHistory.entry.imageModel, imageModel);
    assert.equal(publicHistory.entry.model, null);
    const health = await (await fetch(`${origin}/healthz`)).json();
    assert.ok(health.imageModels.includes('gpt-image-2.6-flare'));
    assert.ok(health.imageModels.includes('gpt-image-2.5-sunburst'));
    assert.ok(health.imageModels.includes('qwen-image-2.1'));
    assert.ok(health.imageModels.includes(imageModel));
  });
}

for (const imageModel of ['krea2', 'krea2-fast']) {
  test(`web rejects a ${imageModel} job with a reference before writing history or submitting to the Mac`, async (t) => {
    const { submissions, historyDir } = await startFakeMac(t);
    const origin = await startWeb(t, `reject-${imageModel}-reference`);
    const form = new FormData();
    form.set('prompt', 'a red teapot');
    form.set('imageModel', imageModel);
    form.append('images', new Blob([PNG], { type: 'image/png' }), 'ref.png');

    const response = await fetch(`${origin}/api/generate`, { method: 'POST', body: form });

    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.match(result.error, /Krea 2.*참고 이미지/);
    assert.deepEqual(await fs.readdir(historyDir), []);
    assert.deepEqual(submissions, []);
  });
}

for (const { imageModel, references, uploadLimit } of [
  { imageModel: 'krea2-id', references: 0 },
  { imageModel: 'krea2-id', references: 2 },
  // The app-wide upload limit answers a fifth file first, so it is raised to let the MOSS-Image bound decide.
  { imageModel: 'moss', references: 5, uploadLimit: '8' }
]) {
  test(`web rejects a ${imageModel} job with ${references} references before writing history or submitting to the Mac`, async (t) => {
    if (uploadLimit) {
      const previous = process.env.IMAGEN_MAX_IMAGES;
      process.env.IMAGEN_MAX_IMAGES = uploadLimit;
      t.after(() => {
        if (previous === undefined) delete process.env.IMAGEN_MAX_IMAGES;
        else process.env.IMAGEN_MAX_IMAGES = previous;
      });
    }
    const { submissions, historyDir } = await startFakeMac(t);
    const origin = await startWeb(t, `reject-${imageModel}-${references}-references`);
    // A supported model is never turned away as unknown, so the 400 below is the reference rule.
    const health = await (await fetch(`${origin}/healthz`)).json();
    assert.ok(health.imageModels.includes(imageModel), `Expected the web server to support ${imageModel}`);
    const form = new FormData();
    form.set('prompt', 'a red teapot');
    form.set('imageModel', imageModel);
    for (let index = 0; index < references; index += 1) {
      form.append('images', new Blob([PNG], { type: 'image/png' }), `ref-${index}.png`);
    }

    const response = await fetch(`${origin}/api/generate`, { method: 'POST', body: form });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).ok, false);
    assert.deepEqual(await fs.readdir(historyDir), []);
    assert.deepEqual(submissions, []);
  });
}

test('resumed Qwen completion retains the Mac start time and full elapsed duration', async (t) => {
  const id = '12345678901234567890';
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  const { submissions, historyDir } = await startFakeMac(t, { startedAt });
  await fs.writeFile(path.join(historyDir, `${id}.json`), JSON.stringify({
    id, qwenJobId: REMOTE_ID, imageModel: 'qwen-image-2.1', model: null,
    status: 'running', prompt: 'a red teapot', size: '512x512',
    startedAt, createdAt: startedAt, updatedAt: startedAt, inputImages: []
  }));
  const completed = completedHistory(historyDir, t);
  const origin = await startWeb(t, 'resume');
  await completed;
  const response = await fetch(`${origin}/api/history/${id}`);
  const { entry } = await response.json();
  assert.equal(entry.status, 'done');
  assert.equal(entry.startedAt, startedAt);
  assert.equal(entry.elapsedMs, Date.parse(entry.finishedAt) - Date.parse(startedAt));
  assert.equal(submissions.length, 0);
});

test('fast Qwen job interrupted before its remote ID was saved is resubmitted once in fast mode', async (t) => {
  const id = '0123456789abcdef0123';
  const createdAt = new Date().toISOString();
  const { submissions, historyDir } = await startFakeMac(t);
  await fs.writeFile(path.join(historyDir, `${id}.json`), JSON.stringify({
    id, imageModel: 'qwen-image-2.1-fast', model: null,
    status: 'queued', prompt: 'a red teapot', size: '512x512',
    createdAt, updatedAt: createdAt, inputImages: []
  }));
  const completed = completedHistory(historyDir, t);
  const origin = await startWeb(t, 'recover-fast');
  await completed;
  const { entry } = await (await fetch(`${origin}/api/history/${id}`)).json();
  assert.equal(entry.status, 'done');
  assert.equal(entry.imageModel, 'qwen-image-2.1-fast');
  assert.deepEqual(submissions.map((form) => [form.get('requestId'), form.get('mode')]), [[id, 'fast']]);
});

test('krea2-id job interrupted before its remote ID was saved is resubmitted once with its stored reference', async (t) => {
  const id = 'fedcba9876543210fedc';
  const createdAt = new Date().toISOString();
  const { submissions, historyDir } = await startFakeMac(t);
  const inputDir = path.join(process.env.IMAGEN_DATA_DIR, 'inputs', id);
  await fs.mkdir(inputDir, { recursive: true });
  await fs.writeFile(path.join(inputDir, '01.png'), PNG);
  await fs.writeFile(path.join(historyDir, `${id}.json`), JSON.stringify({
    id, imageModel: 'krea2-id', model: null,
    status: 'queued', prompt: 'a red teapot', size: '512x512',
    createdAt, updatedAt: createdAt, inputImages: [{ mimetype: 'image/png', path: `${id}/01.png` }]
  }));
  const completed = completedHistory(historyDir, t);
  const origin = await startWeb(t, 'recover-krea2-id');
  await completed;
  const { entry } = await (await fetch(`${origin}/api/history/${id}`)).json();
  assert.equal(entry.status, 'done');
  assert.equal(entry.imageModel, 'krea2-id');
  assert.equal(submissions.length, 1);
  const [submitted] = submissions;
  assert.deepEqual([submitted.get('requestId'), submitted.get('mode')], [id, 'krea2-id']);
  const references = await Promise.all(submitted.getAll('images').map(async (file) => Buffer.from(await file.arrayBuffer())));
  assert.deepEqual(references, [PNG]);
});
