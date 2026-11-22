import { expect, test } from "bun:test";
import { join } from "node:path";

test.each([
  ["A candid amateur photographer taking a portrait", "Candid amateur photo, A candid amateur photographer taking a portrait"],
  ["An amateur phone photography class on a walk", "Candid amateur photo, An amateur phone photography class on a walk"],
  ["An uncandid amateur photo of a cat", "Candid amateur photo, An uncandid amateur photo of a cat"],
  ["A cat on a sofa", "Candid amateur photo, A cat on a sofa"],
  ["Candid amateur photo, a cat on a sofa", "Candid amateur photo, a cat on a sofa"],
  ["Amateur phone photo of a cat", "Amateur phone photo of a cat"],
  ["CANDID FLASH PHOTO, a cat", "CANDID FLASH PHOTO, a cat"],
])("Krea CLI sends complete trigger phrases to the encoder: %s", async (prompt, expected) => {
  let graph;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 8188,
    async fetch(request) {
      switch (new URL(request.url).pathname) {
        case "/system_stats":
          return Response.json({ system: { argv: [join(import.meta.dir, "ComfyUI/main.py")] } });
        case "/prompt":
          graph = (await request.json()).prompt;
          return Response.json({ error: "trigger graph captured" }, { status: 400 });
        default:
          return new Response("Unexpected fixture route", { status: 404 });
      }
    },
  });
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "gen.mjs"), "--model", "krea2", "--", prompt, "512x512"], {
      env: process.env, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10000,
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("trigger graph captured");
    expect(graph?.["452"].inputs.text).toBe(expected);
  } finally {
    server.stop(true);
  }
});
