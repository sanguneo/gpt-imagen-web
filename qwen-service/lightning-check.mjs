import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { applyLightning } from "./lightning.mjs";

test.each([
  [512, 512],
  [832, 1248],
  [1024, 1024],
])("Lightning v2-RL uses the already shifted release sigmas at %ix%i", async (width, height) => {
  const graph = JSON.parse(await readFile(new URL("./workflow_api.json", import.meta.url), "utf8"));
  applyLightning(graph, { width, height, seed: 42 });
  const sigmas = graph.lightningSigmas.inputs.sigmas.split(", ").map(Number);
  // Independent release contract: inference_config.json at revision 682b2529.
  expect(sigmas).toEqual([1, 0.95418, 0.89508, 0.704534, 0]);
  expect(graph["458"].class_type).toBe("SamplerCustom");
  expect(graph["458"].inputs.cfg).toBe(1);
  expect(graph["458"].inputs.noise_seed).toBe(42);
  expect(graph[graph["458"].inputs.sampler[0]].inputs.sampler_name).toBe("euler");
});

test("Lightning patches the GGUF model without changing text, references or decode links", async () => {
  const graph = JSON.parse(await readFile(new URL("./workflow_api.json", import.meta.url), "utf8"));
  graph["458"].inputs.latent_image = ["452", 2];
  const encoder = structuredClone(graph["452"]);
  const decode = structuredClone(graph["457"]);
  applyLightning(graph, { width: 832, height: 1248, seed: 17 });
  expect(graph["452"]).toEqual(encoder);
  expect(graph["457"]).toEqual(decode);
  expect(graph["458"].inputs.latent_image).toEqual(["452", 2]);
  expect(graph["458"].inputs.positive).toEqual(["452", 0]);
  expect(graph["458"].inputs.negative).toEqual(["452", 1]);
  expect(graph[graph["458"].inputs.model[0]].inputs).toEqual({
    model: ["lightning", 0], device: "auto", dtype: "default",
  });
  expect(graph.lightning.inputs).toEqual({
    model: ["451", 0], lora_name: "qwen_image_21_lightning_v2_rl_4steps_lora_rank64.safetensors", strength_model: 1,
  });
  expect(graph[graph.lightning.inputs.model[0]].class_type).toBe("UnetLoaderGGUF");
});
