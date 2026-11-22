import { createHash, timingSafeEqual } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { isIP } from "node:net";
import { Database } from "bun:sqlite";

const MAX_REF = 12 * 1024 * 1024;
const MAX_REFS = 64 * 1024 * 1024;
const MAX_BODY = MAX_REFS + 1024 * 1024;
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const now = () => new Date().toISOString();
const digest = (text) => createHash("sha256").update(text).digest();

class ServiceError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

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

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(PNG)) return "image/png";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

async function parseJob(request) {
  let fields;
  let images = [];
  const type = request.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await request.formData();
    for (const key of form.keys()) {
      if (!["prompt", "negative", "size", "seed", "images", "requestId", "mode"].includes(key)) throw new ServiceError("Unknown field", 400);
    }
    fields = {};
    for (const key of ["prompt", "negative", "size", "seed", "requestId", "mode"]) {
      const values = form.getAll(key);
      if (values.length > 1 || values.some((value) => typeof value !== "string")) throw new ServiceError(`Invalid ${key}`, 400);
      if (values.length) fields[key] = values[0];
    }
    images = form.getAll("images");
  } else if (type.startsWith("application/json")) {
    fields = await request.json();
    if (!fields || typeof fields !== "object" || Array.isArray(fields)
      || Object.keys(fields).some((key) => !["prompt", "negative", "size", "seed", "requestId", "mode"].includes(key))) {
      throw new ServiceError("Expected prompt, negative, size and optional seed or mode; JSON does not accept references", 400);
    }
  } else {
    throw new ServiceError("Use multipart/form-data or application/json", 415);
  }
  if (typeof fields.prompt !== "string" || !fields.prompt.trim() || fields.prompt.length > 60000) throw new ServiceError("Invalid prompt (1..60000 characters)", 400);
  if (fields.requestId !== undefined && (typeof fields.requestId !== "string" || !/^[0-9a-f]{20}$/.test(fields.requestId))) throw new ServiceError("Invalid requestId (20 lowercase hex characters)", 400);
  if (fields.mode !== undefined && !["normal", "fast", "krea2", "krea2-fast", "krea2-id"].includes(fields.mode)) throw new ServiceError("Invalid mode (normal, fast, krea2, krea2-fast or krea2-id)", 400);
  if (fields.mode === "krea2-id" && images.length !== 1) throw new ServiceError("Krea 2 Identity requires exactly one reference image", 400);
  if (["krea2", "krea2-fast"].includes(fields.mode) && images.length) throw new ServiceError("Krea 2 supports text-to-image only", 400);
  if (fields.negative !== undefined && (typeof fields.negative !== "string" || fields.negative.length > 60000)) throw new ServiceError("Invalid negative", 400);
  if (typeof fields.size !== "string" || !/^\d{3,4}x\d{3,4}$/.test(fields.size)
    || !fields.size.split("x").map(Number).every((n) => n >= 256 && n <= 2048 && n % 32 === 0)) throw new ServiceError("Invalid size", 400);
  let seed = null;
  if (fields.seed !== undefined) {
    if ((typeof fields.seed !== "number" && typeof fields.seed !== "string")
      || (typeof fields.seed === "string" && !/^\d+$/.test(fields.seed))) throw new ServiceError("Invalid seed", 400);
    seed = Number(fields.seed);
    if (!Number.isSafeInteger(seed) || seed < 0) throw new ServiceError("Invalid seed", 400);
  }
  if (images.length > 16) throw new ServiceError("At most 16 images", 400);
  let total = 0;
  const refs = [];
  for (const image of images) {
    if (!(image instanceof File) || image.size === 0 || image.size > MAX_REF) throw new ServiceError("Each image must be 1..12 MiB", 400);
    total += image.size;
    if (total > MAX_REFS) throw new ServiceError("References exceed 64 MiB", 400);
    const bytes = Buffer.from(await image.arrayBuffer());
    const mime = imageType(bytes);
    if (!mime || mime !== image.type) throw new ServiceError("References must be PNG, JPEG, WebP or GIF with matching MIME type", 400);
    refs.push({ bytes, extension: { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mime] });
  }
  return { prompt: fields.prompt, negative: fields.negative ?? "", size: fields.size, seed, refs, requestId: fields.requestId ?? null, mode: fields.mode ?? "normal" };
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
    createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error,
  });

  async function run(job) {
    const directory = join(jobsDir, job.id);
    job.status = "running";
    job.stage = "generating";
    job.startedAt = now();
    await persist(job);
    if (stopping) throw new ServiceError("Service shut down before generation");
    const args = ["--neg", job.input.negative];
    if (job.input.seed !== null) args.push("--seed", String(job.input.seed));
    for (const ref of job.input.refs) args.push("--ref", join(directory, ref));
    if (job.input.mode === "fast" || job.input.mode === "krea2-fast") args.push("--fast");
    if (job.input.mode === "krea2" || job.input.mode === "krea2-fast") args.push("--model", "krea2");
    if (job.input.mode === "krea2-id") args.push("--model", "krea2-id");
    args.push("--", job.input.prompt, job.input.size);
    const stdout = openSync(join(directory, "stdout.log"), "w", 0o600);
    const stderr = openSync(join(directory, "stderr.log"), "w", 0o600);
    try {
      // Start gated: durable PID is committed before generation can begin.
      // The supervisor also kills its entire group if the service disappears.
      const supervisor = `
        use POSIX qw(WNOHANG);
        use Fcntl qw(:flock);
        my $owner = getppid(); my $pid;
        $SIG{ALRM} = sub { kill 'KILL', -$$; };
        alarm 7800;
        my $go = <STDIN>; exit 1 unless defined $go;
        open(my $guard, ">>", shift @ARGV) or die "generation lock open failed";
        flock($guard, LOCK_EX) or die "generation lock failed";
        if (getppid() != $owner) { kill 'KILL', -$$; }
        $pid = fork(); die "fork failed" unless defined $pid;
        if (!$pid) { exec @ARGV; die "exec failed"; }
        while (1) {
          my $done = waitpid($pid, WNOHANG);
          if ($done == $pid) { my $code = $?; exit(($code & 127) ? 128 + ($code & 127) : $code >> 8); }
          if (getppid() != $owner) { kill 'KILL', -$$; }
          select undef, undef, undef, 0.2;
        }`;
      active = Bun.spawn(["/usr/bin/perl", "-e", supervisor, join(jobsDir, "generation.lock"), "/usr/bin/caffeinate", "-i", generator, ...args], {
        env: process.env, cwd: dirname(generator), detached: true,
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
      const outputRoot = await realpath(join(dirname(generator), "output"));
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
