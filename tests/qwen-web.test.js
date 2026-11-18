import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { makeTempDir, PNG_BASE64 } from './helpers.js';
import { normalizeQwenSize, parseQwenSeed } from '../src/qwen.js';

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

test('web Qwen job forwards references and saves the remote PNG in normal history', async (t) => {
  const dir = await makeTempDir('qwen-web-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const png = Buffer.from(PNG_BASE64, 'base64');
  const remoteId = '12345678901234567890abcdef12345678';
  let submitted;
  const mac = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer local-test-token') {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'POST' && req.url === '/jobs') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request('http://mac/jobs', { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) });
      submitted = await request.formData();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: remoteId }));
    } else if (req.url === `/jobs/${remoteId}/image`) {
      res.setHeader('Content-Type', 'image/png');
      res.end(png);
    } else if (req.url === `/jobs/${remoteId}`) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: remoteId, status: 'done', queuePosition: 0 }));
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
  const { app } = await import('../src/web-server.js');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const historyDir = path.join(process.env.IMAGEN_DATA_DIR, 'history');
  const completed = completedHistory(historyDir, t);
  const form = new FormData();
  form.set('prompt', 'a red teapot');
  form.set('imageModel', 'qwen-image-2.1');
  form.set('size', '512x512');
  form.set('negative', 'text, blurry');
  form.set('seed', '42');
  form.append('images', new Blob([png], { type: 'image/png' }), 'ref.png');
  const response = await fetch(`${origin}/api/generate`, { method: 'POST', body: form });
  assert.equal(response.status, 202);
  const { entry: accepted } = await response.json();
  const done = await completed;
  assert.equal(done.status, 'done');
  assert.equal(done.id, accepted.id);
  assert.equal(done.provider, 'qwen-local');
  assert.equal(submitted.get('requestId'), accepted.id);
  assert.equal(submitted.get('negative'), 'text, blurry');
  assert.equal(submitted.get('seed'), '42');
  assert.equal(submitted.get('size'), '512x512');
  assert.deepEqual(Buffer.from(await submitted.get('images').arrayBuffer()), png);
  assert.deepEqual(Buffer.from(await (await fetch(origin + done.imageUrl)).arrayBuffer()), png);
  const publicHistory = await (await fetch(`${origin}/api/history/${done.id}`)).json();
  assert.equal(publicHistory.entry.imageModel, 'qwen-image-2.1');
  assert.equal(publicHistory.entry.model, null);
  const health = await (await fetch(`${origin}/healthz`)).json();
  assert.ok(health.imageModels.includes('gpt-image-2.6-flare'));
  assert.ok(health.imageModels.includes('gpt-image-2.5-sunburst'));
  assert.ok(health.imageModels.includes('qwen-image-2.1'));
});

test('resumed Qwen completion retains the Mac start time and full elapsed duration', async (t) => {
  const dir = await makeTempDir('qwen-resume-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const id = '12345678901234567890';
  const remoteId = '11111111-2222-4333-8444-555555555555';
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  const png = Buffer.from(PNG_BASE64, 'base64');
  let submissions = 0;
  const mac = http.createServer((req, res) => {
    if (req.method === 'POST') { submissions++; res.writeHead(409).end(); return; }
    if (req.url === `/jobs/${remoteId}/image`) {
      res.setHeader('Content-Type', 'image/png');
      res.end(png);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: remoteId, status: 'done', startedAt }));
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
  await fs.writeFile(path.join(historyDir, `${id}.json`), JSON.stringify({
    id, qwenJobId: remoteId, imageModel: 'qwen-image-2.1', model: null,
    status: 'running', prompt: 'a red teapot', size: '512x512',
    startedAt, createdAt: startedAt, updatedAt: startedAt, inputImages: []
  }));
  const completed = completedHistory(historyDir, t);
  const { app } = await import('../src/web-server.js?resume');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await completed;
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/history/${id}`);
  const { entry } = await response.json();
  assert.equal(entry.status, 'done');
  assert.equal(entry.startedAt, startedAt);
  assert.equal(entry.elapsedMs, Date.parse(entry.finishedAt) - Date.parse(startedAt));
  assert.equal(submissions, 0);
});
