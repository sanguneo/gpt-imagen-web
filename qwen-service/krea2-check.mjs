import { expect, test } from "bun:test";
import { join } from "node:path";

async function captureGraph(prompt, fast = false) {
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
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "gen.mjs"), "--model", "krea2", ...(fast ? ["--fast"] : []), "--", prompt, "512x512"], {
      env: process.env, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 10000,
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(stderr).toContain("trigger graph captured");
    return graph;
  } finally {
    server.stop(true);
  }
}

test.each([
  ["A candid amateur photographer taking a portrait", "Candid amateur photo, A candid amateur photographer taking a portrait"],
  ["An amateur phone photography class on a walk", "Candid amateur photo, An amateur phone photography class on a walk"],
  ["An uncandid amateur photo of a cat", "Candid amateur photo, An uncandid amateur photo of a cat"],
  ["A cat on a sofa", "Candid amateur photo, A cat on a sofa"],
  ["Candid amateur photo, a cat on a sofa", "Candid amateur photo, a cat on a sofa"],
  ["Amateur phone photo of a cat", "Amateur phone photo of a cat"],
  ["CANDID FLASH PHOTO, a cat", "CANDID FLASH PHOTO, a cat"],
])("Krea CLI sends complete trigger phrases to the encoder: %s", async (prompt, expected) => {
  const graph = await captureGraph(prompt);
  expect(graph["452"].inputs.text).toBe(expected);
});

test.each([
  { fast: false, steps: 52, cfg: 4.5, mu: 0.58125 },
  { fast: true, steps: 8, cfg: 1, mu: 1.15 },
])("Krea fast=$fast uses the released preset and complete model chain", async ({ fast, steps, cfg, mu }) => {
  const graph = await captureGraph("A cat on a sofa", fast);
  expect(graph["451"].inputs.unet_name).toBe("krea2_raw_fp8_scaled.safetensors");
  expect(graph["480"].inputs.lora_name).toBe("Verite_realism.safetensors");
  expect(graph["480"].inputs.strength_model).toBe(1);
  expect(graph["481"].inputs.model).toEqual(["480", 0]);
  expect(graph["481"].inputs.base_shift).toBe(mu);
  expect(graph["481"].inputs.max_shift).toBe(mu);
  expect(graph["458"].inputs.steps).toBe(steps);
  expect(graph["458"].inputs.cfg).toBe(cfg);
  expect(graph["458"].inputs.sampler_name).toBe("euler");
  expect(graph["458"].inputs.scheduler).toBe("simple");
  expect(graph["452"].inputs.text).toBe("Candid amateur photo, A cat on a sofa");
  if (fast) {
    expect(graph["480"].inputs.model).toEqual(["kreaTurbo", 0]);
    expect(graph.kreaTurbo.inputs).toEqual({ model: ["451", 0], lora_name: "krea2_turbo_lora_rank_64_bf16.safetensors", strength_model: 1 });
    expect(graph["455"]).toEqual({ class_type: "ConditioningZeroOut", inputs: { conditioning: ["452", 0] } });
  } else {
    expect(graph["480"].inputs.model).toEqual(["451", 0]);
    expect(graph.kreaTurbo).toBeUndefined();
    expect(graph["455"].class_type).toBe("CLIPTextEncode");
  }
});
