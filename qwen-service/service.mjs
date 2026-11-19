import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { isIP } from "node:net";
import { Database } from "bun:sqlite";
import { generationSupervisor } from "./generation-process.mjs";
import { MAX_BODY, PNG, parseJob, ServiceError } from "./service-input.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const now = () => new Date().toISOString();
const digest = (text) => createHash("sha256").update(text).digest();

function tailnetHost(host) {
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 100 && b >= 64 && b <= 127;
  }
  return isIP(host) === 6 && /^fd7a:115c:a1e0:/i.test(host);
}

async function atomic(path, data) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function signalGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || error.code !== "ESRCH") throw error;
  }
}

async function main() {
  const host = process.env.QWEN_HOST;
  if (!tailnetHost(host ?? "")) throw new ServiceError("QWEN_HOST must be a literal tailnet address (100.64.0.0/10 or fd7a:115c:a1e0::/48)");
  const port = Number(process.env.QWEN_PORT ?? 8789);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ServiceError("Invalid QWEN_PORT");
  const root = join(homedir(), "qwen-image");
  const jobsDir = process.env.QWEN_JOBS_DIR ?? join(root, "jobs");
  const generator = process.env.QWEN_GENERATOR ?? join(import.meta.dir, "gen.sh");
  if (!isAbsolute(generator)) throw new ServiceError("QWEN_GENERATOR must be an absolute executable path");
  const mossGenerator = process.env.MOSS_GENERATOR ?? join(import.meta.dir, "moss.sh");
  if (!isAbsolute(mossGenerator)) throw new ServiceError("MOSS_GENERATOR must be an absolute executable path");
  const tokenFile = process.env.QWEN_TOKEN_FILE ?? join(root, "service.token");
  const tokenStat = await stat(tokenFile);
  if (!tokenStat.isFile() || (tokenStat.mode & 0o077) !== 0) throw new ServiceError("Token file must be private (mode 600)");
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token || /\s/.test(token)) throw new ServiceError("Token file must contain one nonempty Bearer token");
  const expected = digest(`Bearer ${token}`);
  await mkdir(jobsDir, { recursive: true, mode: 0o700 });
  // OS-released exclusive lock: concurrent service instances cannot own one queue.
  const lock = new Database(join(jobsDir, "service-lock.sqlite"), { create: true });
  lock.exec("BEGIN EXCLUSIVE");
  const jobs = new Map();
  const requests = new Map();
  const queue = [];
  let submissions = Promise.resolve();
  let stopping = false;
  let active = null;
  let worker = null;
  let server;
  const persist = (job) => atomic(join(jobsDir, job.id, "job.json"), JSON.stringify(job));
  const publicJob = (job) => ({
    id: job.id, status: job.status, stage: job.stage,
    queuePosition: job.status === "queued" ? queue.indexOf(job.id) + 1 : 0,
    mode: job.input?.mode ?? "normal",
    model: job.input?.model ?? "qwen-image",
    createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error,
  });

  async function run(job) {
    const directory = join(jobsDir, job.id);
    const moss = job.input.model === "moss-image";
    const executable = moss ? mossGenerator : generator;
    const scratch = moss ? join(directory, "moss-run") : "";
    job.status = "running";
    job.stage = "generating";
    job.startedAt = now();
    await persist(job);
    if (stopping) throw new ServiceError("Service shut down before generation");
    const args = ["--neg", job.input.negative];
    if (job.input.seed !== null) args.push("--seed", String(job.input.seed));
    for (const ref of job.input.refs) args.push("--ref", join(directory, ref));
    if (job.input.mode === "fast") args.push("--fast");
    args.push("--", job.input.prompt, job.input.size);
    const stdout = openSync(join(directory, "stdout.log"), "w", 0o600);
    const stderr = openSync(join(directory, "stderr.log"), "w", 0o600);
    try {
      if (moss) await mkdir(scratch, { mode: 0o700 });
      // Start gated: durable PID is committed before generation can begin.
      // The supervisor also kills its entire group if the service disappears.
      active = Bun.spawn(["/usr/bin/perl", "-e", generationSupervisor, moss ? "1800" : "7800", scratch, join(jobsDir, "generation.lock"), "/usr/bin/caffeinate", "-i", executable, ...args], {
        env: moss ? { ...process.env, TMPDIR: scratch, NODE_COMPILE_CACHE: join(scratch, "node"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(scratch, "bun") } : process.env,
        cwd: dirname(executable), detached: true,
        stdin: "pipe", stdout, stderr,
      });
      job.pid = active.pid;
      await persist(job);
      active.stdin.write("GO\n");
      active.stdin.end();
      const code = await active.exited;
      active = null;
      job.pid = null;
      if (stopping) throw new ServiceError("Service shut down during generation");
      if (code !== 0) throw new ServiceError(`Generator exited with code ${code}; see stderr.log`);
      const outputLog = join(directory, "stdout.log");
      if ((await stat(outputLog)).size > 16384) throw new ServiceError("Unexpected generator stdout");
      const outputText = (await readFile(outputLog, "utf8")).trim();
      if (!isAbsolute(outputText) || outputText.includes("\n") || outputText.includes("\r")) throw new ServiceError("Generator must emit exactly one absolute output path");
      const outputRoot = await realpath(join(dirname(executable), "output"));
      const output = await realpath(outputText);
      if (!output.startsWith(outputRoot + sep) || !(await stat(output)).isFile()) throw new ServiceError("Generator output escaped output directory");
      const bytes = await readFile(output);
      if (!bytes.subarray(0, 8).equals(PNG)) throw new ServiceError("Generator output is not PNG");
      await atomic(join(directory, "image.png"), bytes);
      job.status = "done";
      job.stage = "done";
    } finally {
      if (active && active.exitCode === null) {
        signalGroup(active.pid, "SIGKILL");
        await active.exited;
      }
      active = null;
      closeSync(stdout);
      closeSync(stderr);
      if (moss) await rm(scratch, { recursive: true, force: true });
    }
  }

  async function drain() {
    while (!stopping && queue.length) {
      const job = jobs.get(queue.shift());
      try {
        await run(job);
      } catch (error) { // Job boundary: record failures without stopping later jobs.
        job.status = "error";
        job.stage = "error";
        job.error = error instanceof Error ? error.message : "Generation failed";
      }
      job.pid = null;
      job.finishedAt = now();
      await persist(job);
    }
  }
  function kick() {
    if (worker || stopping) return;
    worker = drain().then(() => {
      worker = null;
      if (queue.length) kick();
    });
    worker.catch((error) => {
      console.error(error instanceof Error ? "Qwen job persistence failed; stopping service." : "Qwen worker failed; stopping service.");
      shutdown(1);
    });
  }
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    await server?.stop(true);
    if (active?.exitCode === null) signalGroup(active.pid, "SIGKILL");
    if (worker) await worker.catch((error) => {
      if (!(error instanceof Error)) throw error;
      code = 1;
    });
    lock.close();
    process.exit(code);
  }
  process.on("SIGTERM", () => { shutdown(); });
  process.on("SIGINT", () => { shutdown(); });

  for (const id of await readdir(jobsDir)) {
    if (!UUID.test(id)) continue;
    const job = JSON.parse(await readFile(join(jobsDir, id, "job.json"), "utf8"));
    if (job.id !== id || !["queued", "running", "done", "error"].includes(job.status)) throw new ServiceError("Invalid durable job metadata");
    if (job.status === "running") {
      // A running job is never requeued, even if output was written before a crash.
      Object.assign(job, { status: "error", stage: "error", pid: null, finishedAt: now(), error: "Service interrupted during generation" });
      await persist(job);
    }
    jobs.set(id, job);
    if (job.requestId) {
      if (requests.has(job.requestId)) throw new ServiceError("Duplicate durable requestId");
      requests.set(job.requestId, id);
    }
  }
  queue.push(...[...jobs.values()].filter((job) => job.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((job) => job.id));

  server = Bun.serve({
    hostname: host, port, maxRequestBodySize: MAX_BODY, development: false,
    async fetch(request) {
      if (!timingSafeEqual(expected, digest(request.headers.get("authorization") ?? ""))) return Response.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
      try {
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === "/jobs") {
          const input = await parseJob(request);
          let release;
          const previous = submissions;
          submissions = new Promise((resolve) => { release = resolve; });
          await previous;
          try {
            if (stopping) throw new ServiceError("Service stopping", 503);
            const existing = input.requestId && requests.get(input.requestId);
            if (existing) return Response.json({ id: existing }, { status: 202 });
            const id = crypto.randomUUID();
            // Uncommitted submissions are ignored at startup; rename commits the job.
            const directory = join(jobsDir, `.pending-${id}`);
            await mkdir(directory, { mode: 0o700 });
            const refs = [];
            for (const [index, ref] of input.refs.entries()) {
              const name = `ref-${index}.${ref.extension}`;
              await atomic(join(directory, name), ref.bytes);
              refs.push(name);
            }
            const { requestId, ...generation } = input;
            const job = { id, requestId, status: "queued", stage: "queued", createdAt: now(), startedAt: null, finishedAt: null, error: null, pid: null, input: { ...generation, refs } };
            await atomic(join(directory, "job.json"), JSON.stringify(job));
            await rename(directory, join(jobsDir, id));
            const parent = await open(jobsDir, "r");
            try { await parent.sync(); } finally { await parent.close(); }
            jobs.set(id, job);
            if (requestId) requests.set(requestId, id);
            queue.push(id);
            kick();
            return Response.json({ id }, { status: 202 });
          } finally {
            release();
          }
        }
        const match = /^\/jobs\/([0-9a-f-]+)(\/image)?$/.exec(path);
        const job = match && jobs.get(match[1]);
        if (request.method !== "GET" || !job) throw new ServiceError("Not found", 404);
        if (!match[2]) return Response.json(publicJob(job), { headers: { "Cache-Control": "no-store" } });
        if (job.status !== "done") throw new ServiceError("Image not ready", 409);
        return new Response(Bun.file(join(jobsDir, job.id, "image.png")), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
      } catch (error) { // HTTP boundary: never expose internal paths or request bodies.
        const status = error instanceof ServiceError ? error.status : error instanceof SyntaxError || error instanceof TypeError ? 400 : 500;
        return Response.json({ error: status < 500 && error instanceof Error ? error.message : "Service request failed" }, { status });
      }
    },
  });
  console.log(JSON.stringify({ event: "listening", host, port: server.port }));
  kick();
}

main().catch(() => {
  // Configuration and filesystem errors must not echo token content.
  console.error("Qwen service failed to start; check host, private token file, and jobs store.");
  process.exit(1);
});
