import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { parseArgs } from "node:util";
import { mossWorkflow } from "./moss-workflow.mjs";

const root = import.meta.dir;
const comfy = join(root, "ComfyUI");
const base = "http://127.0.0.1:8189";
const budget = 30 * 60_000;
const png = Buffer.from("89504e470d0a1a0a", "hex");
let server;
let run;
let streams;
const cancellation = new AbortController();
const cancel = () => cancellation.abort(new Error("MOSS generation cancelled"));
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);

async function api(path, data) {
  const response = await fetch(base + path, {
    signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(30000)]),
    redirect: "error",
    ...(data === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }),
  });
  if (!response.ok) throw new Error(`ComfyUI ${path}: HTTP ${response.status}`);
  return response.json();
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { neg: { type: "string", default: "" }, seed: { type: "string" } },
  });
  const [prompt, size = "512x512", ...extra] = positionals;
  if (!prompt?.trim() || extra.length) throw new Error("Usage: moss.sh [--neg TEXT] [--seed N] -- PROMPT [WxH]");
  const sides = size.split("x").map(Number);
  const [width, height = width] = sides;
  if (sides.length > 2 || ![width, height].every((n) => Number.isInteger(n) && n >= 256 && n <= 2048 && n % 32 === 0)) {
    throw new Error("Size must have sides 256..2048, multiples of 32");
  }
  const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 48) : Number(values.seed);
  if (values.seed !== undefined && (!/^\d+$/.test(values.seed) || !Number.isSafeInteger(seed) || seed < 0)) {
    throw new Error("Seed must be a nonnegative safe integer");
  }
  // Never share a server with Qwen or silently take ownership of an occupied port.
  const occupied = Bun.spawn(["/usr/sbin/lsof", "-nP", "-iTCP:8189", "-sTCP:LISTEN"], {
    env: process.env, stdin: "ignore", stdout: "ignore", stderr: "inherit",
  });
  const portCode = await occupied.exited;
  if (portCode !== 1) throw new Error(portCode === 0 ? "Port 8189 is already occupied" : "Cannot check port 8189");
  cancellation.signal.throwIfAborted();
  run = await mkdtemp(join(tmpdir(), "moss-gen-"));
  for (const name of ["input", "user", "temp"]) await mkdir(join(run, name));
  await mkdir(join(root, "output"), { recursive: true });
  const env = {
    ...process.env, TMPDIR: run,
    NODE_COMPILE_CACHE: join(run, "node"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(run, "bun"),
    XDG_CACHE_HOME: join(run, "cache"), HF_HOME: join(run, "hf"), TORCH_HOME: join(run, "torch"),
    MPLCONFIGDIR: join(run, "matplotlib"), HF_HUB_DISABLE_IMPLICIT_TOKEN: "1", HF_HUB_OFFLINE: "1",
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PYTORCH_ENABLE_MPS_FALLBACK: "1",
  };
  server = Bun.spawn([
    join(root, ".venv/bin/python"), "-u", join(comfy, "main.py"),
    "--listen", "127.0.0.1", "--port", "8189", "--offline", "--preview-method", "none",
    "--models-directory", join(comfy, "models"), "--output-directory", join(root, "output"),
    "--input-directory", join(run, "input"), "--user-directory", join(run, "user"),
    "--temp-directory", join(run, "temp"), "--disable-auto-launch",
  ], { cwd: comfy, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let startupLog = "";
  const consume = async (stream) => {
    for await (const chunk of stream) {
      const text = new TextDecoder().decode(chunk);
      process.stderr.write(text);
      startupLog = (startupLog + text).slice(-4096);
      if (startupLog.includes("To see the GUI go to:")) readyResolve();
    }
  };
  streams = Promise.all([consume(server.stdout), consume(server.stderr)]);
  server.exited.then((code) => readyReject(new Error(`ComfyUI exited before readiness (${code})`)));
  const startup = setTimeout(() => readyReject(new Error("ComfyUI startup exceeded 180 seconds")), 180000);
  const abortReady = () => readyReject(cancellation.signal.reason);
  cancellation.signal.addEventListener("abort", abortReady, { once: true });
  try {
    cancellation.signal.throwIfAborted();
    await ready;
  } finally {
    clearTimeout(startup);
    cancellation.signal.removeEventListener("abort", abortReady);
  }
  const prefix = `moss_${crypto.randomUUID()}`;
  const graph = mossWorkflow({ prompt, negative: values.neg, width, height, seed, prefix });
  console.error(`MOSS seed ${seed}, ${width}x${height}, 30 steps, CFG 3, Euler/simple`);
  const { prompt_id: id } = await api("/prompt", { prompt: graph, client_id: crypto.randomUUID() });
  if (typeof id !== "string") throw new Error("ComfyUI returned no prompt ID");
  const deadline = performance.now() + budget;
  let output;
  while (performance.now() < deadline) {
    cancellation.signal.throwIfAborted();
    if (server.exitCode !== null) throw new Error(`ComfyUI exited (${server.exitCode})`);
    const item = (await api(`/history/${encodeURIComponent(id)}`))[id];
    if (item?.status?.status_str === "error") throw new Error("ComfyUI execution failed");
    if (item?.status?.status_str === "success") {
      const images = item.outputs?.["11"]?.images;
      if (images?.length !== 1 || images[0].type !== "output") throw new Error("Expected exactly one output image");
      const directory = await realpath(join(root, "output"));
      const image = images[0];
      output = await realpath(join(directory, image.subfolder, image.filename));
      if (!output.startsWith(directory + sep) || !image.filename.startsWith(prefix) || !output.endsWith(".png")) {
        throw new Error("Unexpected MOSS output path");
      }
      const bytes = await readFile(output);
      if (!bytes.subarray(0, 8).equals(png)) throw new Error("MOSS output is not PNG");
      break;
    }
    await new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(cancellation.signal.reason); };
      const timer = setTimeout(() => { cancellation.signal.removeEventListener("abort", abort); resolve(); }, 1500);
      cancellation.signal.addEventListener("abort", abort, { once: true });
    });
  }
  if (!output) throw new Error("MOSS generation exceeded 30 minutes");
  console.log(output);
} catch (error) { // CLI boundary: diagnostics never enter stdout.
  console.error(error instanceof Error ? error.message : "MOSS generation failed");
  process.exitCode = 1;
} finally {
  if (server?.exitCode === null) {
    server.kill("SIGTERM");
    const kill = setTimeout(() => { if (server.exitCode === null) server.kill("SIGKILL"); }, 5000);
    await server.exited;
    clearTimeout(kill);
  }
  await streams;
  if (run) await rm(run, { recursive: true, force: true });
  process.removeListener("SIGTERM", cancel);
  process.removeListener("SIGINT", cancel);
}
