import { expect, onTestFinished, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

async function installation() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moss-generator-check-")));
  const processes = [];
  onTestFinished(async () => {
    for (const proc of processes) {
      if (proc.exitCode === null) proc.kill("SIGTERM");
      await proc.exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  for (const folder of ["ComfyUI", ".venv/bin", "scratch"]) await mkdir(join(root, folder), { recursive: true });
  for (const file of ["moss-workflow.mjs", "moss.sh"]) await copyFile(join(import.meta.dir, file), join(root, file));
  // Relocate only the copied executable's transport endpoint. The real Mac
  // service or another checkout may already own its production port.
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = reservation.port;
  await reservation.stop(true);
  const generator = await readFile(join(import.meta.dir, "moss.mjs"), "utf8");
  await writeFile(join(root, "moss.mjs"), generator.replaceAll("8189", String(port)));
  // Execute the shipped launcher against a wire-level ComfyUI fake. No Python,
  // installed models, live generator, or model API is used by this fixture.
  await writeFile(join(root, ".venv/bin/python"), `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(root, "fake-comfy.mjs"))} "$@"\n`, { mode: 0o700 });
  await writeFile(join(root, "fake-comfy.mjs"), `
import { join } from "node:path";
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name)+1];
const output = option("--output-directory");
let graph;
await Bun.write(join(import.meta.dir,"server-pid"),String(process.pid));
const server = Bun.serve({hostname:"127.0.0.1",port:Number(option("--port")),async fetch(request) {
  if(new URL(request.url).pathname === "/prompt") {
    graph = (await request.json()).prompt;
    await Bun.write(join(import.meta.dir,"submitted.json"),JSON.stringify(graph));
    return Response.json({prompt_id:"test-prompt"});
  }
  if(graph["5"].inputs.text.includes("hold")) return Response.json({});
  const prefix = graph["11"].inputs.filename_prefix;
  const filename = prefix+".png";
  await Bun.write(join(output,filename), graph["5"].inputs.text.includes("invalid-png") ? "not png" : Buffer.from(${JSON.stringify(png)},"base64"));
  return Response.json({"test-prompt":{status:{status_str:"success"},outputs:{"11":{images:[{type:"output",subfolder:"",filename}]}}}});
}});
console.log("To see the GUI go to: http://127.0.0.1:"+server.port);
`);
  const start = (args) => {
    const proc = Bun.spawn(["/bin/bash", join(root, "moss.sh"), ...args], {
      env: { ...process.env, PATH: `${join(process.execPath, "..")}:${process.env.PATH}`, TMPDIR: join(root, "scratch"), NODE_COMPILE_CACHE: join(root, "scratch/node"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "scratch/bun") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    processes.push(proc);
    return { proc, stdout: new Response(proc.stdout).text(), stderr: new Response(proc.stderr).text() };
  };
  return { root, start };
}

function submitted(root) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error("MOSS never submitted a workflow")); }, 10000);
    const watcher = watch(root, async () => {
      if (await Bun.file(join(root, "submitted.json")).exists()) {
        clearTimeout(timer);
        watcher.close();
        resolve();
      }
    });
  });
}

test("shipped MOSS CLI uses its adjacent installation and emits only one absolute PNG path", async () => {
  const { root, start } = await installation();
  const { proc, stdout, stderr } = start(["--neg", "blurry", "--seed", "17", "--", "fictional adult portrait", "832x1248"]);
  expect(await proc.exited).toBe(0);
  const text = await stdout;
  expect(text).toMatch(new RegExp(`^${root}/output/moss_[a-f0-9-]+\\.png\\n$`));
  expect(Buffer.from(await readFile(text.trim()))).toEqual(Buffer.from(png, "base64"));
  const graph = JSON.parse(await readFile(join(root, "submitted.json"), "utf8"));
  expect(graph["5"].inputs.text).toBe("moss_xvstyle, fictional adult portrait");
  expect(graph["6"].inputs.text).toBe("blurry");
  expect(graph["7"].inputs).toEqual({ width: 832, height: 1248, batch_size: 1 });
  expect(graph["9"].inputs.seed).toBe(17);
  expect(await stderr).toContain("MOSS seed 17");
  const pid = Number(await readFile(join(root, "server-pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  expect((await readdir(join(root, "scratch"))).filter((name) => name.startsWith("moss-gen-"))).toEqual([]);
});

test.each(["--ref", "--fast", "--steps"])("MOSS CLI rejects unsupported %s before starting ComfyUI", async (flag) => {
  const { root, start } = await installation();
  const { proc, stdout, stderr } = start([flag, "--", "portrait", "512x512"]);
  expect(await proc.exited).toBe(1);
  expect(await stdout).toBe("");
  expect(await stderr).toContain("Unknown option");
  expect(await Bun.file(join(root, "server-pid")).exists()).toBe(false);
});

test("MOSS CLI validates image bytes before printing a path", async () => {
  const { start } = await installation();
  const { proc, stdout, stderr } = start(["--", "invalid-png", "512x512"]);
  expect(await proc.exited).toBe(1);
  expect(await stdout).toBe("");
  expect(await stderr).toContain("MOSS output is not PNG");
});

test("MOSS CLI cancellation stops its server and removes temporary files", async () => {
  const { root, start } = await installation();
  const ready = submitted(root);
  const { proc, stdout, stderr } = start(["--", "hold", "512x512"]);
  await ready;
  const pid = Number(await readFile(join(root, "server-pid"), "utf8"));
  proc.kill("SIGTERM");
  expect(await proc.exited).toBe(1);
  expect(await stdout).toBe("");
  expect(await stderr).toContain("MOSS generation cancelled");
  expect(() => process.kill(pid, 0)).toThrow();
  expect((await readdir(join(root, "scratch"))).filter((name) => name.startsWith("moss-gen-"))).toEqual([]);
});
