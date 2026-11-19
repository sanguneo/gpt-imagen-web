import { expect, onTestFinished } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const host = Object.values(networkInterfaces()).flat().find((entry) =>
  entry?.family === "IPv4" && /^100\./.test(entry.address) && Number(entry.address.split(".")[1]) >= 64 && Number(entry.address.split(".")[1]) <= 127)?.address;
if (!host) throw new Error("HTTP tests require an active tailnet IPv4 interface");
export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
export const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const authorization = "Bearer test-only-local-token";
const resources = [];

// Filesystem notifications drive checks; deadlines only fail a stuck test.
export function observe(directory, check) {
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

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qwen-service-"));
  const processes = [];
  resources.push({ root, processes });
  onTestFinished(cleanupFixtures);
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
const model = import.meta.path.includes("fake-moss") ? "moss-image" : "qwen-image";
const {positionals:[prompt,size], values} = parseArgs({allowPositionals:true,options:{neg:{type:"string"},seed:{type:"string"},ref:{type:"string",multiple:true,default:[]},fast:{type:"boolean"}}});
const options = ["--neg",values.neg,...(values.seed === undefined ? [] : ["--seed",values.seed]),...values.ref.flatMap(ref => ["--ref",ref]),...(values.fast ? ["--fast"] : [])];
await mkdir(join(root, "exclusive"));
await appendFile(join(root, "calls"), JSON.stringify({prompt, size, options, model, pid:process.pid, scratch:process.env.TMPDIR})+"\\n");
let descendant;
if (model === "moss-image") await writeFile(join(process.env.TMPDIR, "child-temp"), "owned");
if (model === "moss-image" && prompt === "hold") {
  descendant = Bun.spawn([process.execPath, "-e", 'await Bun.write(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', join(root,"descendant")], {
    env:process.env, stdin:"ignore", stdout:"ignore", stderr:"inherit"
  });
}
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
if (descendant) { descendant.kill(); await descendant.exited; }
await rm(join(root, "exclusive"), {recursive:true});
console.error("finished fake generation");
if (prompt === "escape") console.log(join(root, "token"));
else if (prompt === "multiple") console.log(output+"\\n"+output);
else console.log(output);
`, { mode: 0o700 });
  const mossGenerator = join(root, "fake-moss-generator.mjs");
  await copyFile(generator, mossGenerator);
  async function start(overrides = {}) {
    const proc = Bun.spawn(["/usr/bin/perl", "-e", "alarm 60; exec @ARGV", process.execPath, join(import.meta.dir, "service.mjs")], {
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, QWEN_HOST: host, QWEN_PORT: "0", QWEN_TOKEN_FILE: join(root, "token"), QWEN_JOBS_DIR: join(root, "jobs"), QWEN_GENERATOR: generator, MOSS_GENERATOR: mossGenerator, ...overrides },
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

export async function cleanupFixtures() {
  for (const { root, processes } of resources.splice(0)) {
    for (const proc of processes) {
      if (proc.exitCode === null) proc.kill("SIGTERM");
      await proc.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}
