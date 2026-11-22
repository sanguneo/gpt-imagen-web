import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const host = Object.values(networkInterfaces()).flat().find((entry) =>
  entry?.family === "IPv4" && /^100\./.test(entry.address) && Number(entry.address.split(".")[1]) >= 64 && Number(entry.address.split(".")[1]) <= 127)?.address;
if (!host) throw new Error("HTTP tests require an active tailnet IPv4 interface");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const authorization = "Bearer test-only-local-token";
const resources = [];

// Filesystem notifications drive checks; deadlines only fail a stuck test.
function observe(directory, check) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Timed out waiting for observable state")), 10000);
    const watcher = watch(directory, { recursive: true }, inspect);
    let finished = false;
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error); else resolve(result);
    }
    async function inspect() {
      try {
        const result = await check();
        if (result) finish(null, result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Observation failed"));
      }
    }
    inspect();
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qwen-service-"));
  const processes = [];
  resources.push({ root, processes });
  await mkdir(join(root, "output"));
  await mkdir(join(root, "jobs"));
  await writeFile(join(root, "token"), "test-only-local-token\n", { mode: 0o600 });
  const generator = join(root, "fake-generator.mjs");
  await writeFile(generator, `#!/usr/bin/env bun
import { mkdir, appendFile, readFile, writeFile, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
const root = import.meta.dir;
const {positionals:[prompt,size], values} = parseArgs({allowPositionals:true,options:{neg:{type:"string"},seed:{type:"string"},ref:{type:"string",multiple:true,default:[]},fast:{type:"boolean"},model:{type:"string"}}});
if (prompt === "krea test" && values.model !== "krea2") process.exit(9);
const options = ["--neg",values.neg,...(values.seed === undefined ? [] : ["--seed",values.seed]),...values.ref.flatMap(ref => ["--ref",ref]),...(values.fast ? ["--fast"] : [])];
await mkdir(join(root, "exclusive"));
await appendFile(join(root, "calls"), JSON.stringify({prompt, size, options, pid:process.pid})+"\\n");
if (prompt === "hold") await new Promise((resolve) => {
  const watcher = watch(root, async () => {
    if (await Bun.file(join(root,"release")).exists()) { watcher.close(); resolve(); }
  });
  Bun.file(join(root,"release")).exists().then((exists) => { if (exists) { watcher.close(); resolve(); } });
});
if (prompt === "fail") { await rm(join(root, "exclusive"), {recursive:true}); console.error("deliberate failure"); process.exit(7); }
for (let i=0;i<options.length;i++) {
  if (options[i] === "--ref") {
    const bytes = await readFile(options[++i]);
    const png = Buffer.from(${JSON.stringify(png.toString("base64"))},"base64");
    const gif = Buffer.from(${JSON.stringify(gif.toString("base64"))},"base64");
    if (!bytes.subarray(0,png.length).equals(png) && !bytes.equals(gif)) process.exit(8);
  }
}
const output = join(root, "output", crypto.randomUUID()+".png");
await writeFile(output, Buffer.from(${JSON.stringify(png.toString("base64"))}, "base64"));
await rm(join(root, "exclusive"), {recursive:true});
console.error("finished fake generation");
if (prompt === "escape") console.log(join(root, "token"));
else if (prompt === "multiple") console.log(output+"\\n"+output);
else console.log(output);
`, { mode: 0o700 });
  async function start(overrides = {}) {
    const proc = Bun.spawn(["/usr/bin/perl", "-e", "alarm 60; exec @ARGV", process.execPath, join(import.meta.dir, "service.mjs")], {
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, QWEN_HOST: host, QWEN_PORT: "0", QWEN_TOKEN_FILE: join(root, "token"), QWEN_JOBS_DIR: join(root, "jobs"), QWEN_GENERATOR: generator, ...overrides },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    processes.push(proc);
    const errors = new Response(proc.stderr).text();
    let text = "";
    for await (const bytes of proc.stdout) {
      text += new TextDecoder().decode(bytes);
      if (text.includes("\n")) break;
    }
    if (!text) throw new Error(`Service exited ${await proc.exited}: ${await errors}`);
    const { port } = JSON.parse(text.trim());
    const url = `http://${host}:${port}`;
    const http = (path, options = {}) => fetch(url + path, { ...options, headers: { Authorization: authorization, ...options.headers }, signal: AbortSignal.timeout(10000) });
    const submit = async (body = {}) => {
      const response = await http("/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "ok", size: "256x256", ...body }) });
      expect(response.status).toBe(202);
      return (await response.json()).id;
    };
    const status = async (id) => (await http(`/jobs/${id}`)).json();
    const state = (id, expected) => observe(root, async () => {
      const job = await status(id);
      return job.status === expected ? job : false;
    });
    const stop = async (signal = "SIGTERM") => {
      proc.kill(signal);
      await proc.exited;
    };
    return { proc, http, submit, status, state, stop, errors };
  }
  return { root, start, processes };
}

afterEach(async () => {
  for (const { root, processes } of resources.splice(0)) {
    for (const proc of processes) {
      if (proc.exitCode === null) proc.kill("SIGTERM");
      await proc.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["json", "multipart"])("Krea mode generates and persists through %s", async (transport) => {
  const { root, start } = await fixture();
  const app = await start();
  let id;
  if (transport === "json") {
    id = await app.submit({ prompt: "krea test", mode: "krea2" });
  } else {
    const form = new FormData();
    form.set("prompt", "krea test");
    form.set("size", "512x512");
    form.set("mode", "krea2");
    const response = await app.http("/jobs", { method: "POST", body: form });
    expect(response.status).toBe(202);
    id = (await response.json()).id;
  }
  expect((await app.state(id, "done")).mode).toBe("krea2");
  expect(Buffer.from(await (await app.http(`/jobs/${id}/image`)).arrayBuffer())).toEqual(png);
  expect(JSON.parse(await readFile(join(root, "jobs", id, "job.json"), "utf8")).input.mode).toBe("krea2");
});

test("Krea references are rejected before generation", async () => {
  const { root, start } = await fixture();
  const app = await start();
  const form = new FormData();
  form.set("prompt", "krea test");
  form.set("size", "512x512");
  form.set("mode", "krea2");
  form.append("images", new Blob([png], { type: "image/png" }), "ref.png");
  const response = await app.http("/jobs", { method: "POST", body: form });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("Krea");
  expect(await Bun.file(join(root, "calls")).exists()).toBe(false);
});

test("all routes require Bearer auth before routing or parsing", async () => {
  const { start } = await fixture();
  const { http } = await start();
  for (const [path, method, token] of [
    ["/jobs", "POST", ""], ["/jobs/missing", "GET", "Bearer wrong"],
    ["/jobs/missing/image", "GET", "bearer test-only-local-token"], ["/unknown", "GET", ""],
  ]) {
    const response = await http(path, { method, headers: { Authorization: token } });
    expect(response.status).toBe(401);
  }
  expect((await http("/unknown")).status).toBe(404);
});

test.each([
  { prompt: "" }, { prompt: 5 }, { negative: 5 }, { size: "255x256" },
  { size: "288x2050" }, { size: "2049x256" }, { size: "512" },
  { seed: -1 }, { seed: 1.1 }, { seed: Number.MAX_SAFE_INTEGER + 1 }, { seed: "" },
  { requestId: "ABCDEF01234567890123" }, { requestId: "1234" }, { images: [] },
  { mode: "turbo" }, { mode: "FAST" }, { mode: "" }, { mode: true }, { mode: null }, { mode: ["fast"] }, { mode: 1 },
])("invalid JSON field is rejected: %j", async (invalid) => {
  const { start } = await fixture();
  const { http } = await start();
  const response = await http("/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "ok", size: "256x256", ...invalid }) });
  expect(response.status).toBe(400);
});

test.each([
  { label: "omitted", body: {}, options: ["--neg", ""], mode: "normal" },
  { label: "explicit normal", body: { mode: "normal" }, options: ["--neg", ""], mode: "normal" },
  { label: "fast", body: { mode: "fast", seed: 7 }, options: ["--neg", "", "--seed", "7", "--fast"], mode: "fast" },
])("JSON mode $label reaches the generator invocation", async ({ body, options, mode }) => {
  const { root, start } = await fixture();
  const app = await start();
  const id = await app.submit(body);
  const job = await app.state(id, "done");
  expect(job.mode).toBe(mode);
  const calls = JSON.parse((await readFile(join(root, "calls"), "utf8")).trim());
  expect(calls.options).toEqual(options);
  expect(calls.prompt).toBe("ok");
  expect(JSON.parse(await readFile(join(root, "jobs", id, "job.json"), "utf8")).input.mode).toBe(mode);
});

test("multipart fast mode with references reaches the generator invocation", async () => {
  const { root, start } = await fixture();
  const app = await start();
  const form = new FormData();
  form.set("prompt", "ok");
  form.set("size", "256x256");
  form.set("mode", "fast");
  form.append("images", new Blob([png], { type: "image/png" }), "ref.png");
  const response = await app.http("/jobs", { method: "POST", body: form });
  expect(response.status).toBe(202);
  const { id } = await response.json();
  expect((await app.state(id, "done")).mode).toBe("fast");
  const calls = JSON.parse((await readFile(join(root, "calls"), "utf8")).trim());
  expect(calls.options).toEqual(["--neg", "", "--ref", join(root, "jobs", id, "ref-0.png"), "--fast"]);
});

test.each(["turbo", "FAST", "", "duplicate", "file"])("invalid multipart mode rejected: %j", async (kind) => {
  const { root, start } = await fixture();
  const app = await start();
  const form = new FormData();
  form.set("prompt", "ok");
  form.set("size", "256x256");
  if (kind === "duplicate") { form.append("mode", "fast"); form.append("mode", "fast"); }
  else if (kind === "file") form.set("mode", new Blob(["fast"], { type: "text/plain" }), "mode.txt");
  else form.set("mode", kind);
  expect((await app.http("/jobs", { method: "POST", body: form })).status).toBe(400);
  expect(await Bun.file(join(root, "calls")).exists()).toBe(false);
});

test("queued fast mode survives restart and legacy jobs without mode run normal", async () => {
  const { root, start } = await fixture();
  const legacy = crypto.randomUUID();
  await mkdir(join(root, "jobs", legacy));
  await writeFile(join(root, "jobs", legacy, "job.json"), JSON.stringify({
    id: legacy, requestId: null, status: "queued", stage: "queued", createdAt: "2000-01-01T00:00:00.000Z",
    startedAt: null, finishedAt: null, error: null, pid: null,
    input: { prompt: "legacy", negative: "", size: "256x256", seed: null, refs: [] },
  }));
  const holder = await start();
  expect((await holder.state(legacy, "done")).mode).toBe("normal");
  // Hold a running job so the fast job is still queued when the service is killed.
  const running = await holder.submit({ prompt: "hold" });
  await observe(root, async () => (await readFile(join(root, "calls"), "utf8")).trim().split("\n").length === 2);
  const queued = await holder.submit({ prompt: "fast queued", mode: "fast" });
  expect((await holder.status(queued)).mode).toBe("fast");
  expect((await holder.status(queued)).queuePosition).toBe(1);
  await holder.stop("SIGKILL");
  await rm(join(root, "exclusive"), { recursive: true });
  const second = await start();
  expect((await second.status(running)).status).toBe("error");
  expect((await second.status(queued)).mode).toBe("fast");
  await second.state(queued, "done");
  const calls = (await readFile(join(root, "calls"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(calls.map((call) => call.prompt)).toEqual(["legacy", "hold", "fast queued"]);
  expect(calls[0].options).toEqual(["--neg", ""]);
  expect(calls[2].options).toEqual(["--neg", "", "--fast"]);
});

test("multipart refs and options reach generation and return a durable PNG", async () => {
  const { root, start } = await fixture();
  const app = await start();
  const form = new FormData();
  form.set("prompt", "--help");
  form.set("negative", "blurry");
  form.set("size", "2048x256");
  form.set("seed", String(Number.MAX_SAFE_INTEGER));
  form.append("images", new Blob([png], { type: "image/png" }), "../unsafe.png");
  const response = await app.http("/jobs", { method: "POST", body: form });
  expect(response.status).toBe(202);
  const { id } = await response.json();
  const job = await app.state(id, "done");
  expect(job.queuePosition).toBe(0);
  expect(job.error).toBeNull();
  expect(job.startedAt).not.toBeNull();
  expect(job.finishedAt).not.toBeNull();
  const image = await app.http(`/jobs/${id}/image`);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
  const calls = JSON.parse((await readFile(join(root, "calls"), "utf8")).trim());
  expect(calls.size).toBe("2048x256");
  expect(calls.options.slice(0, 4)).toEqual(["--neg", "blurry", "--seed", String(Number.MAX_SAFE_INTEGER)]);
  expect(await readFile(join(root, "jobs", id, "stderr.log"), "utf8")).toContain("finished fake generation");
});

test.each(["mime", "oversize", "count", "total", "text", "duplicate"])("invalid multipart refs rejected: %s", async (kind) => {
  const { start } = await fixture();
  const app = await start();
  const form = new FormData();
  form.set("prompt", "ok");
  form.set("size", "256x256");
  if (kind === "text") form.set("images", "not a file");
  else if (kind === "duplicate") form.append("size", "512x512");
  else {
    const count = kind === "count" ? 17 : kind === "total" ? 9 : 1;
    const bytes = kind === "mime" ? Buffer.from("not an image") : kind === "oversize" ? Buffer.alloc(12 * 1024 * 1024 + 1) : kind === "total" ? Buffer.alloc(Math.ceil(7.2 * 1024 * 1024)) : png;
    if (kind !== "mime") png.copy(bytes, 0, 0, Math.min(bytes.length, png.length));
    for (let i = 0; i < count; i++) form.append("images", new Blob([bytes], { type: kind === "mime" ? "image/jpeg" : "image/png" }), "ref.png");
  }
  expect((await app.http("/jobs", { method: "POST", body: form })).status).toBe(400);
});

test("serial queue survives restart, interrupts running work and deduplicates retries", async () => {
  const { root, start } = await fixture();
  const first = await start();
  const key = "0123456789abcdefabcd";
  const running = await first.submit({ prompt: "hold" });
  await observe(root, async () => await Bun.file(join(root, "calls")).exists());
  const runningJob = await first.state(running, "running");
  expect(runningJob.queuePosition).toBe(0);
  expect(runningJob.stage).toBe("generating");
  const form = () => {
    const data = new FormData();
    data.set("prompt", "second");
    data.set("size", "256x256");
    data.set("requestId", key);
    return data;
  };
  const responses = await Promise.all(Array.from({ length: 4 }, () => first.http("/jobs", { method: "POST", body: form() })));
  const ids = await Promise.all(responses.map(async (response) => {
    expect(response.status).toBe(202);
    return (await response.json()).id;
  }));
  expect(new Set(ids).size).toBe(1);
  const queued = ids[0];
  expect((await first.status(queued)).queuePosition).toBe(1);
  expect((await first.http(`/jobs/${queued}/image`)).status).toBe(409);
  expect((await readFile(join(root, "calls"), "utf8")).trim().split("\n").length).toBe(1);
  const childPid = JSON.parse((await readFile(join(root, "calls"), "utf8")).trim()).pid;
  await first.stop("SIGKILL");
  // The fake's exclusive marker deliberately persists when killed.
  // Removing its marker allows the next fake to prove queue recovery.
  await rm(join(root, "exclusive"), { recursive: true });
  const second = await start();
  expect((await second.status(running)).status).toBe("error");
  await second.state(queued, "done");
  expect(() => process.kill(childPid, 0)).toThrow();
  expect(await second.submit({ requestId: key })).toBe(queued);
  expect((await readFile(join(root, "calls"), "utf8")).trim().split("\n").length).toBe(2);
  await second.stop();
  await rm(join(root, "output"), { recursive: true });
  await mkdir(join(root, "output"));
  const third = await start();
  expect((await third.status(queued)).status).toBe("done");
  expect(await third.submit({ requestId: key })).toBe(queued);
  expect(Buffer.from(await (await third.http(`/jobs/${queued}/image`)).arrayBuffer())).toEqual(png);
  expect((await readFile(join(root, "calls"), "utf8")).trim().split("\n").length).toBe(2);
});

test.each(["fail", "escape", "multiple"])("generator %s becomes a durable error without serving an image", async (prompt) => {
  const { root, start } = await fixture();
  const first = await start();
  const requestId = "abcdef0123456789abcd";
  const id = await first.submit({ prompt, requestId });
  const job = await first.state(id, "error");
  expect(job.error).not.toBeNull();
  expect(job.finishedAt).not.toBeNull();
  expect((await first.http(`/jobs/${id}/image`)).status).toBe(409);
  await first.stop();
  const second = await start();
  expect((await second.status(id)).status).toBe("error");
  expect(await second.submit({ prompt, requestId })).toBe(id);
  expect((await readFile(join(root, "calls"), "utf8")).trim().split("\n").length).toBe(1);
});

test("graceful shutdown kills generation and permits queued successor", async () => {
  const { root, start } = await fixture();
  const first = await start();
  const id = await first.submit({ prompt: "hold" });
  await observe(root, async () => await Bun.file(join(root, "calls")).exists());
  const pid = JSON.parse((await readFile(join(root, "calls"), "utf8")).trim()).pid;
  const queued = await first.submit();
  await first.stop();
  expect(() => process.kill(pid, 0)).toThrow();
  await rm(join(root, "exclusive"), { recursive: true });
  const second = await start();
  expect((await second.status(id)).status).toBe("error");
  await second.state(queued, "done");
});

test.each(["0.0.0.0", "127.0.0.1", "192.168.1.1", "localhost", "::", "100.128.0.1"])("rejects non-tailnet bind %s before listening", async (QWEN_HOST) => {
  const { start } = await fixture();
  const error = await start({ QWEN_HOST }).then(() => null, (failure) => failure);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toContain("Service exited 1");
});

test("second service cannot take ownership of a live queue", async () => {
  const { start } = await fixture();
  const first = await start();
  const failure = await start().then(() => null, (error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toContain("Service exited 1");
  await first.state(await first.submit(), "done");
});

test("public token file permissions fail closed", async () => {
  const { root, start } = await fixture();
  await chmod(join(root, "token"), 0o644);
  const failure = await start().then(() => null, (error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toContain("Service exited 1");
});

test("failed generation releases the queue for the next job", async () => {
  const { start } = await fixture();
  const app = await start();
  const failed = await app.submit({ prompt: "fail" });
  const next = await app.submit();
  expect((await app.state(failed, "error")).error).toContain("code 7");
  await app.state(next, "done");
});

test("sixteen valid references are accepted and fully processed", async () => {
  const { start } = await fixture();
  const app = await start();
  const form = new FormData();
  form.set("prompt", "sixteen references");
  form.set("size", "256x2048");
  form.set("seed", "0");
  for (let i = 0; i < 16; i++) form.append("images", new Blob([png], { type: "image/png" }), `${i}.png`);
  const response = await app.http("/jobs", { method: "POST", body: form });
  expect(response.status).toBe(202);
  await app.state((await response.json()).id, "done");
});

test("malformed JSON unsupported bodies and oversized requests are rejected", async () => {
  const { start } = await fixture();
  const app = await start();
  for (const [contentType, body, expected] of [
    ["application/json", "{", 400],
    ["text/plain", "prompt", 415],
    ["application/json", Buffer.alloc(65 * 1024 * 1024 + 1), 413],
  ]) {
    expect((await app.http("/jobs", { method: "POST", headers: { "Content-Type": contentType }, body })).status).toBe(expected);
  }
});

test("web boundary accepts 60000 characters and rejects longer scalar fields", async () => {
  const { start } = await fixture();
  const app = await start();
  await app.state(await app.submit({ prompt: "p".repeat(60000), negative: "n".repeat(60000) }), "done");
  for (const field of ["prompt", "negative"]) {
    const response = await app.http("/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "ok", size: "256x256", [field]: "x".repeat(60001) }) });
    expect(response.status).toBe(400);
  }
});

test.each(["gif", "12MiB"])("web reference %s is stored unchanged and forwarded successfully", async (kind) => {
  const { root, start } = await fixture();
  const app = await start();
  const data = kind === "gif" ? gif : Buffer.alloc(12 * 1024 * 1024);
  if (kind !== "gif") png.copy(data);
  const form = new FormData();
  form.set("prompt", "web reference");
  form.set("size", "256x256");
  form.append("images", new Blob([data], { type: kind === "gif" ? "image/gif" : "image/png" }), kind === "gif" ? "ref.gif" : "ref.png");
  const response = await app.http("/jobs", { method: "POST", body: form });
  expect(response.status).toBe(202);
  const { id } = await response.json();
  await app.state(id, "done");
  expect(await readFile(join(root, "jobs", id, kind === "gif" ? "ref-0.gif" : "ref-0.png"))).toEqual(data);
});

test("startup never signals an unrelated live group recorded by interrupted metadata", async () => {
  const { root, start, processes } = await fixture();
  const unrelated = Bun.spawn(["/usr/bin/perl", "-e", "alarm 60; exec @ARGV", process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    env: process.env, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  processes.push(unrelated);
  const id = crypto.randomUUID();
  await mkdir(join(root, "jobs", id));
  await writeFile(join(root, "jobs", id, "job.json"), JSON.stringify({
    id, status: "running", pid: unrelated.pid, stage: "generating",
    createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null, error: null,
  }));
  const app = await start();
  expect((await app.status(id)).status).toBe("error");
  await app.state(await app.submit(), "done");
  expect(unrelated.exitCode).toBeNull();
  expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
});
