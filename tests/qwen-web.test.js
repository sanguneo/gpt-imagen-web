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
  assert.equal(normalizeQwenSize('auto', 'moss-image'), '512x512');
  for (const size of ['3840x2160', '513x512', '0x512', '512x512x512']) {
    assert.throws(() => normalizeQwenSize(size), { status: 400 });
  }
  for (const seed of ['-1', '1.2', '9007199254740992', 'no']) {
    assert.throws(() => parseQwenSeed(seed), { status: 400 });
  }
  assert.equal(parseQwenSeed('0'), 0);
});

for (const { imageModel, mode, references } of [
  { imageModel: 'qwen-image-2.1', mode: 'normal', references: true },
  { imageModel: 'qwen-image-2.1-fast', mode: 'fast', references: true },
  { imageModel: 'moss-image', mode: 'normal', references: false }
]) {
  test(`web ${imageModel} job submits ${mode} mode and saves the remote PNG with its model identity`, async (t) => {
    const { submissions, historyDir } = await startFakeMac(t);
    const origin = await startWeb(t, `create-${imageModel}`);
    const completed = completedHistory(historyDir, t);
    const form = new FormData();
    form.set('prompt', 'a red teapot');
    form.set('imageModel', imageModel);
    form.set('size', '512x512');
    form.set('negative', 'text, blurry');
    form.set('seed', '42');
    if (references) form.append('images', new Blob([PNG], { type: 'image/png' }), 'ref.png');
    const response = await fetch(`${origin}/api/generate`, { method: 'POST', body: form });
    assert.equal(response.status, 202);
    const { entry: accepted } = await response.json();
    const done = await completed;
    assert.equal(done.status, 'done');
    assert.equal(done.id, accepted.id);
    assert.equal(done.provider, imageModel === 'moss-image' ? 'moss-local' : 'qwen-local');
    assert.equal(submissions.length, 1);
    const [submitted] = submissions;
    assert.equal(submitted.get('requestId'), accepted.id);
    assert.equal(submitted.get('mode'), mode);
    assert.equal(submitted.get('model'), imageModel === 'moss-image' ? 'moss-image' : null);
    assert.equal(submitted.get('negative'), 'text, blurry');
    assert.equal(submitted.get('seed'), '42');
    assert.equal(submitted.get('size'), '512x512');
    if (references) assert.deepEqual(Buffer.from(await submitted.get('images').arrayBuffer()), PNG);
    else assert.equal(submitted.get('images'), null);
    assert.deepEqual(Buffer.from(await (await fetch(origin + done.imageUrl)).arrayBuffer()), PNG);
    const publicHistory = await (await fetch(`${origin}/api/history/${done.id}`)).json();
    assert.equal(publicHistory.entry.imageModel, imageModel);
    assert.equal(publicHistory.entry.model, null);
    const health = await (await fetch(`${origin}/healthz`)).json();
    assert.ok(health.imageModels.includes('gpt-image-2.6-flare'));
    assert.ok(health.imageModels.includes('gpt-image-2.5-sunburst'));
    assert.ok(health.imageModels.includes('qwen-image-2.1'));
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

for (const imageModel of ['qwen-image-2.1-fast', 'moss-image']) {
test(`${imageModel} interrupted before its remote ID was saved resumes with the same model`, async (t) => {
  const id = '0123456789abcdef0123';
  const createdAt = new Date().toISOString();
  const { submissions, historyDir } = await startFakeMac(t);
  await fs.writeFile(path.join(historyDir, `${id}.json`), JSON.stringify({
    id, imageModel, model: null,
    status: 'queued', prompt: 'a red teapot', size: '512x512',
    createdAt, updatedAt: createdAt, inputImages: []
  }));
  const completed = completedHistory(historyDir, t);
  const origin = await startWeb(t, `recover-${imageModel}`);
  await completed;
  const { entry } = await (await fetch(`${origin}/api/history/${id}`)).json();
  assert.equal(entry.status, 'done');
  assert.equal(entry.imageModel, imageModel);
  assert.deepEqual(submissions.map((form) => [form.get('requestId'), form.get('mode'), form.get('model')]),
    [[id, imageModel === 'moss-image' ? 'normal' : 'fast', imageModel === 'moss-image' ? 'moss-image' : null]]);
});
}

test('MOSS reference uploads are rejected before a remote job is submitted', async (t) => {
  const { submissions } = await startFakeMac(t);
  const origin = await startWeb(t, 'moss-references');
  const form = new FormData();
  form.set('prompt', 'a fictional adult portrait');
  form.set('imageModel', 'moss-image');
  form.set('size', '512x512');
  form.append('images', new Blob([PNG], { type: 'image/png' }), 'ref.png');
  const response = await fetch(`${origin}/api/generate`, { method: 'POST', body: form });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /MOSS.*참고/);
  assert.equal(submissions.length, 0);
});
