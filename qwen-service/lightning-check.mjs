import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { applyLightning } from "./lightning.mjs";

test.each([
  [512, 512, 0.5387096774193548],
  [832, 1248, 0.6915322580645161],
  [1024, 1024, 0.6935483870967742],
])("Lightning follows the official dynamic Euler schedule at %ix%i", async (width, height, mu) => {
  const graph = JSON.parse(await readFile(new URL("./workflow_api.json", import.meta.url), "utf8"));
  applyLightning(graph, { width, height, seed: 42 });
  const sigmas = graph.lightningSigmas.inputs.sigmas.split(", ").map(Number);
  // Invert the shifted training points: logit(sigma) - logit(t) must equal mu.
  expect(sigmas.length).toBe(5);
  expect(sigmas[0]).toBe(1);
  expect(sigmas[4]).toBe(0);
  for (const [index, training] of [0.75, 0.5, 0.25].entries()) {
    expect(Math.log(sigmas[index + 1] / (1 - sigmas[index + 1])) - Math.log(training / (1 - training))).toBeCloseTo(mu, 12);
  }
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
    model: ["lightning", 0], device: "off", dtype: "default",
  });
  expect(graph.lightning.inputs).toEqual({
    model: ["451", 0], lora_name: "qwen-image-2.1-lightning-4step.safetensors", strength_model: 1,
  });
  expect(graph[graph.lightning.inputs.model[0]].class_type).toBe("UnetLoaderGGUF");
});
