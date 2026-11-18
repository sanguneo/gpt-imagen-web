import { realpath, readFile } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { parseArgs } from "node:util";
import { applyLightning } from "./lightning.mjs";

const root = import.meta.dir;
const base = "http://127.0.0.1:8188";
const usage = `Usage: gen.sh "<prompt>" [size | WxH] [options]
  size / WxH        1024 (default) or e.g. 832x1216; each side 256–2048, multiple of 32
  --neg TEXT        negative prompt (default: none)
  --seed N          seed (default: random; printed to stderr)
  --steps N         sampling steps (default 35)
  --cfg X           CFG scale (default 5)
  --sampler NAME    KSampler sampler (default er_sde)
  --scheduler NAME  KSampler scheduler (default simple)
  --fast            4-step Qwen-Image-2.1 Lightning, CFG 1, Euler with training sigmas
  --batch N         images per run, 1–4 (default 1)
  --ref FILE        reference image (repeatable, up to 16); without a size the output follows the first one`;

function fail(message) {
  console.error(`${message}\n${usage}`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      neg: { type: "string", default: " " },
      seed: { type: "string" },
      steps: { type: "string" },
      cfg: { type: "string" },
      sampler: { type: "string" },
      scheduler: { type: "string" },
      fast: { type: "boolean", default: false },
      batch: { type: "string", default: "1" },
      ref: { type: "string", multiple: true, default: [] },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (error) {
  fail(error.message);
}
if (args.values.help) {
  console.log(usage);
  process.exit(0);
}
const fast = args.values.fast;
if (fast && ["steps", "cfg", "sampler", "scheduler"].some((key) => args.values[key] !== undefined)) {
  fail("--fast uses a fixed 4-step training schedule and cannot combine with --steps/--cfg/--sampler/--scheduler.");
}
args.values.steps ??= fast ? "4" : "35";
args.values.cfg ??= fast ? "1" : "5";
args.values.sampler ??= fast ? "euler" : "er_sde";
args.values.scheduler ??= fast ? "lightning (dynamic exponential, no terminal stretching)" : "simple";
const [prompt, sizeArg, ...extra] = args.positionals;
const sizeText = sizeArg ?? "1024";
const refs = args.values.ref;
if (refs.length > 16) fail("At most 16 --ref images.");
for (const ref of refs) if (!(await Bun.file(ref).exists())) fail(`No such file: ${ref}`);
// With references and no explicit size, sample on the first reference's latent size.
const refSized = refs.length > 0 && sizeArg === undefined;
if (!prompt?.trim() || extra.length) fail("Expected one prompt and an optional size.");
const sides = sizeText.toLowerCase().split("x").map(Number);
const [width, height = width] = sides;
if (sides.length > 2 || ![width, height].every((n) => Number.isInteger(n) && n >= 256 && n <= 2048 && n % 32 === 0)) {
  fail(`Bad size: ${sizeText}`);
}
const int = (name, min, max) => {
  const n = Number(args.values[name]);
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be an integer ${min}–${max}.`);
  return n;
};
const seed = args.values.seed === undefined
  ? Math.floor(Math.random() * 2 ** 48)
  : int("seed", 0, Number.MAX_SAFE_INTEGER);
const steps = int("steps", 1, 200);
const batch = int("batch", 1, 4);
const cfg = Number(args.values.cfg);
if (!Number.isFinite(cfg) || cfg < 0 || cfg > 30) fail("--cfg must be a number 0–30.");

async function api(path, data) {
  const response = await fetch(base + path, {
    signal: AbortSignal.timeout(8000),
    redirect: "error",
    ...(data === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    }),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function ownServerAvailable() {
  let stats;
  try {
    stats = await api("/system_stats");
  } catch (error) {
    if (error?.code === "ECONNREFUSED") return false;
    throw error;
  }
  if (!stats.system?.argv?.includes(join(root, "ComfyUI/main.py"))) {
    throw new Error("Port 8188 is already in use by a different server.");
  }
  return true;
}

async function queue() {
  const graph = JSON.parse(await readFile(join(root, "workflow_api.json"), "utf8"));
  const prefix = `qwen_${refSized ? "ref" : `${width}x${height}`}_${crypto.randomUUID().slice(0, 8)}`;
  for (const [i, ref] of refs.entries()) {
    const form = new FormData();
    form.append("image", Bun.file(ref), `${prefix}_ref${i + 1}${extname(ref)}`);
    form.append("overwrite", "true");
    const response = await fetch(base + "/upload/image", { method: "POST", body: form, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`/upload/image: ${response.status} ${await response.text()}`);
    const { name, subfolder } = await response.json();
    const node = `ref${i + 1}`;
    graph[node] = { class_type: "LoadImage", inputs: { image: subfolder ? `${subfolder}/${name}` : name } };
    graph["452"].inputs[`images.image_${i + 1}`] = [node, 0];
  }
  if (refs.length) graph["452"].inputs.vae = ["454", 0];
  Object.assign(graph["452"].inputs, { prompt, negative_prompt: args.values.neg, resolution: Math.round(Math.sqrt(width * height) / 32) * 32 });
  Object.assign(graph["456"].inputs, { width, height, batch_size: batch });
  if (refSized) {
    if (batch > 1) throw new Error("--batch needs an explicit size when using --ref.");
    graph["458"].inputs.latent_image = ["452", 2];
    delete graph["456"];
  }
  Object.assign(graph["458"].inputs, {
    seed, steps, cfg, sampler_name: args.values.sampler, scheduler: args.values.scheduler,
  });
  if (fast) {
    let samplingWidth = width, samplingHeight = height;
    if (refSized) {
      // Match TextEncodeQwenImage21's EXIF-aware first-reference resize.
      const probe = Bun.spawn([
        "/usr/bin/perl", "-e", "alarm 10; exec @ARGV", join(root, ".venv/bin/python"), "-c",
        "import sys,json,math; from PIL import Image,ImageOps; im=ImageOps.exif_transpose(Image.open(sys.argv[1])); r=im.width/im.height; s=int(sys.argv[2]); print(json.dumps([max(32,round(math.sqrt(s*s*r)/32)*32),max(32,round(math.sqrt(s*s/r)/32)*32)]))",
        refs[0], String(graph["452"].inputs.resolution),
      ], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
      const dimensions = await new Response(probe.stdout).text();
      if (await probe.exited !== 0) throw new Error("Cannot read first reference dimensions.");
      [samplingWidth, samplingHeight] = JSON.parse(dimensions);
    }
    applyLightning(graph, { width: samplingWidth, height: samplingHeight, seed });
  }
  graph["485"].inputs.filename_prefix = prefix;
  console.error(`Seed: ${seed}, steps ${steps}, cfg ${cfg}, ${args.values.sampler}/${args.values.scheduler}, ${refSized ? "size of ref 1" : `${width}x${height}`} x${batch}, refs ${refs.length}`);
  const started = performance.now();
  const { prompt_id: id } = await api("/prompt", { prompt: graph, client_id: crypto.randomUUID() });
  if (typeof id !== "string") throw new Error("Missing prompt ID.");
  const url = `/history/${encodeURIComponent(id)}`;
  while (performance.now() - started < 120 * 60_000) {
    const item = (await api(url))[id];
    if (item?.status?.status_str === "error") {
      const message = item.status.messages?.find(([type]) => type === "execution_error")?.[1];
      throw new Error(message?.exception_message ?? JSON.stringify(item.status));
    }
    const images = item?.outputs?.["485"]?.images;
    if (images?.length && images.every((image) => image.type === "output")) {
      const output = await realpath(join(root, "output"));
      const paths = [];
      for (const image of images) {
        const path = await realpath(join(output, image.subfolder, image.filename));
        if (!path.startsWith(output + sep) || !image.filename.startsWith(prefix)) {
          throw new Error("Unexpected output path.");
        }
        paths.push(path);
      }
      console.error(`Generation: ${((performance.now() - started) / 1000).toFixed(2)} s`);
      return paths.join("\n");
    }
    await Bun.sleep(1500);
  }
  throw new Error("Generation timed out after 120 minutes.");
}

let server;
try {
  if (!(await ownServerAvailable())) {
    server = Bun.spawn(["/bin/bash", join(root, "start.sh")], {
      env: process.env, stdin: "ignore", stdout: "ignore", stderr: "inherit", timeout: 125 * 60_000,
    });
    const deadline = performance.now() + 120_000;
    while (!(await ownServerAvailable())) {
      if (server.exitCode !== null || performance.now() > deadline) {
        throw new Error("ComfyUI did not start. See logs/comfy.log.");
      }
      await Bun.sleep(500);
    }
  }
  console.log(await queue());
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([server.exited, Bun.sleep(5000)]);
    if (server.exitCode === null) {
      server.kill("SIGKILL");
      await server.exited;
    }
  }
  if (server) {
    const peak = server.resourceUsage()?.maxRSS;
    if (peak) console.error(`Peak RSS: ${peak} bytes`);
  }
}
