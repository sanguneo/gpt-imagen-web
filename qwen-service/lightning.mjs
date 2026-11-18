// LightX2V Qwen-Image-2.1-Lightning, revision 6b0a1176327c01522a44276c5da67331a025b6fc.
export function applyLightning(graph, { width, height, seed }) {
  const mu = 0.5 + (width * height / 256 - 256) * (0.9 - 0.5) / (8192 - 256);
  const shift = Math.exp(mu);
  const sigmas = [1, 0.75, 0.5, 0.25].map((sigma) => shift / (shift + (1 / sigma - 1)));
  sigmas.push(0);
  graph.lightning = {
    class_type: "LoraLoaderModelOnly",
    inputs: { model: ["451", 0], lora_name: "qwen-image-2.1-lightning-4step.safetensors", strength_model: 1 },
  };
  graph["480"].inputs.model = ["lightning", 0];
  graph["480"].inputs.device = "off";
  graph.lightningSigmas = { class_type: "ManualSigmas", inputs: { sigmas: sigmas.join(", ") } };
  graph.lightningSampler = { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } };
  const { positive, negative, latent_image } = graph["458"].inputs;
  graph["458"] = {
    class_type: "SamplerCustom",
    inputs: {
      model: ["480", 0], add_noise: true, noise_seed: seed, cfg: 1,
      positive, negative, latent_image, sampler: ["lightningSampler", 0], sigmas: ["lightningSigmas", 0],
    },
  };
}
