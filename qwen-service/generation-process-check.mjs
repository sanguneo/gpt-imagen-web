import { expect, onTestFinished, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generationSupervisor } from "./generation-process.mjs";

test("generation deadline kills the full process group and removes MOSS scratch", async () => {
  const root = await mkdtemp(join(tmpdir(), "moss-supervisor-check-"));
  const scratch = join(root, "scratch");
  await mkdir(scratch);
  const child = `
    import { join } from "node:path";
    const descendant = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
      env:process.env, stdin:"ignore", stdout:"ignore", stderr:"ignore"
    });
    await Bun.write(join(process.argv[1],"pids"),JSON.stringify([process.pid,descendant.pid]));
    await Bun.write(join(process.argv[1],"scratch","owned"),"temporary data");
    console.log("ready");
    setInterval(() => {}, 1000);
  `;
  const proc = Bun.spawn(["/usr/bin/perl", "-e", generationSupervisor, "1", scratch, join(root, "generation.lock"), process.execPath, "-e", child, root], {
    env: process.env, detached: true, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let exited = false;
  proc.exited.then(() => { exited = true; });
  onTestFinished(async () => {
    if (!exited) process.kill(-proc.pid, "SIGKILL");
    await proc.exited;
    await rm(root, { recursive: true, force: true });
  });
  proc.stdin.write("GO\n");
  proc.stdin.end();
  expect(await new Response(proc.stdout).text()).toBe("ready\n");
  expect(await proc.exited).toBe(137);
  expect(await new Response(proc.stderr).text()).toBe("");
  for (const pid of JSON.parse(await readFile(join(root, "pids"), "utf8"))) {
    expect(() => process.kill(pid, 0)).toThrow();
  }
  expect(await readdir(root)).not.toContain("scratch");
});
