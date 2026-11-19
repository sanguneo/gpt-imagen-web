import { expect, test } from "bun:test";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, observe, png } from "./service-fixture.mjs";

const callsAt = async (root) => (await readFile(join(root, "calls"), "utf8")).trim().split("\n").map(JSON.parse);

test.each(["json", "multipart"])("MOSS %s selects its executable and persists model and options", async (format) => {
  const { root, start } = await fixture();
  const app = await start();
  const body = { model: "moss-image", mode: "normal", prompt: "--fictional adult portrait", size: "512x512", negative: "blurry", seed: "17" };
  const response = format === "json"
    ? await app.http("/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    : await app.http("/jobs", { method: "POST", body: Object.entries(body).reduce((form, [key, value]) => { form.set(key, value); return form; }, new FormData()) });
  expect(response.status).toBe(202);
  const { id } = await response.json();
  expect(await app.state(id, "done")).toMatchObject({ model: "moss-image", mode: "normal", error: null });
  expect(JSON.parse(await readFile(join(root, "jobs", id, "job.json"), "utf8")).input).toMatchObject({ ...body, seed: 17, refs: [] });
  expect(await callsAt(root)).toMatchObject([{ model: "moss-image", prompt: body.prompt, size: body.size, options: ["--neg", "blurry", "--seed", "17"] }]);
  expect(Buffer.from(await (await app.http(`/jobs/${id}/image`)).arrayBuffer())).toEqual(png);
  expect(await readdir(join(root, "jobs", id))).not.toContain("moss-run");
});

test.each([
  { model: "" }, { model: "MOSS-Image" }, { model: null }, { model: 1 }, { model: [] },
  { model: "moss-image", mode: "fast" }, { model: "moss-image", size: "513x512" },
  { model: "moss-image", seed: -1 }, { model: "moss-image", steps: 4 }, { model: "moss-image", images: [] },
])("invalid MOSS/model JSON fails before generation: %j", async (invalid) => {
  const { root, start } = await fixture();
  const app = await start();
  const response = await app.http("/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "ok", size: "512x512", ...invalid }) });
  expect(response.status).toBe(400);
  expect(await Bun.file(join(root, "calls")).exists()).toBe(false);
});

test.each(["reference", "fast", "duplicate", "file", "unknown"])("MOSS multipart rejects %s at the boundary", async (kind) => {
  const { root, start } = await fixture();
  const app = await start();
  const form = new FormData();
  form.set("prompt", "ok");
  form.set("size", "512x512");
  form.set("model", "moss-image");
  switch (kind) {
    case "reference": form.append("images", new Blob([png], { type: "image/png" }), "ref.png"); break;
    case "fast": form.set("mode", "fast"); break;
    case "duplicate": form.append("model", "qwen-image"); break;
    case "file": form.set("model", new Blob(["moss-image"]), "model.txt"); break;
    case "unknown": form.set("cfg", "3"); break;
    default: throw new Error(`Unexpected test case ${kind}`);
  }
  expect((await app.http("/jobs", { method: "POST", body: form })).status).toBe(400);
  expect(await Bun.file(join(root, "calls")).exists()).toBe(false);
});

test("MOSS requests require authentication before field parsing", async () => {
  const { root, start } = await fixture();
  const app = await start();
  const response = await app.http("/jobs", { method: "POST", headers: { Authorization: "", "Content-Type": "application/json" }, body: JSON.stringify({ model: "moss-image", mode: "fast" }) });
  expect(response.status).toBe(401);
  expect(await Bun.file(join(root, "calls")).exists()).toBe(false);
});

test.each(["qwen-image", "moss-image"])("shared queue serializes both models behind %s", async (model) => {
  const { root, start } = await fixture();
  const app = await start();
  const first = await app.submit({ model, prompt: "hold" });
  await observe(root, () => Bun.file(join(root, "calls")).exists());
  const secondModel = model === "qwen-image" ? "moss-image" : "qwen-image";
  const second = await app.submit({ model: secondModel, mode: secondModel === "qwen-image" ? "fast" : "normal" });
  expect(await app.status(second)).toMatchObject({ status: "queued", queuePosition: 1, model: secondModel });
  expect((await callsAt(root)).length).toBe(1);
  await writeFile(join(root, "release"), "");
  await app.state(first, "done");
  await app.state(second, "done");
  expect((await callsAt(root)).map((call) => call.model)).toEqual([model, secondModel]);
});

test.each(["SIGTERM", "SIGKILL"])("MOSS %s kills its descendants, cleans scratch and recovers queued Qwen", async (signal) => {
  const { root, start } = await fixture();
  const first = await start();
  const id = await first.submit({ model: "moss-image", prompt: "hold" });
  await observe(root, () => Bun.file(join(root, "descendant")).exists());
  const pid = Number(await readFile(join(root, "descendant"), "utf8"));
  const queued = await first.submit({ mode: "fast" });
  // Watch scratch removal before killing the owner to cover supervisor cleanup.
  const scratchGone = observe(root, async () => !(await Bun.file(join(root, "jobs", id, "moss-run", "child-temp")).exists()));
  await first.stop(signal);
  await scratchGone;
  await rm(join(root, "exclusive"), { recursive: true });
  const second = await start();
  expect((await second.status(id)).status).toBe("error");
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await second.state(queued, "done")).toMatchObject({ model: "qwen-image", mode: "fast" });
});

test("queued MOSS model survives a service restart", async () => {
  const { root, start } = await fixture();
  const first = await start();
  await first.submit({ prompt: "hold" });
  await observe(root, () => Bun.file(join(root, "calls")).exists());
  const queued = await first.submit({ model: "moss-image", size: "832x1248", seed: 0 });
  await first.stop();
  await rm(join(root, "exclusive"), { recursive: true });
  const second = await start();
  expect(await second.state(queued, "done")).toMatchObject({ model: "moss-image", mode: "normal" });
  expect((await callsAt(root))[1]).toMatchObject({ model: "moss-image", size: "832x1248", options: ["--neg", "", "--seed", "0"] });
});

test.each(["escape", "multiple", "fail"])("MOSS %s keeps the existing output-validation boundary", async (prompt) => {
  const { start } = await fixture();
  const app = await start();
  const id = await app.submit({ model: "moss-image", prompt });
  expect((await app.state(id, "error")).error).not.toBeNull();
  expect((await app.http(`/jobs/${id}/image`)).status).toBe(409);
  expect((await app.state(await app.submit(), "done")).model).toBe("qwen-image");
});
