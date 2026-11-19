// LightX2V Qwen-Image-2.1-Lightning-v2-RL, revision 682b2529ffb5ae9ba39ceb81a31ce99e602da2ee.
export function applyLightning(graph, { seed }) {
  // inference_config.json sigmas are already shifted; append only terminal zero.
  const sigmas = [1, 0.95418, 0.89508, 0.704534, 0];
  graph.lightning = {
    class_type: "LoraLoaderModelOnly",
    inputs: { model: ["451", 0], lora_name: "qwen_image_21_lightning_v2_rl_4steps_lora_rank64.safetensors", strength_model: 1 },
  };
  graph["480"].inputs.model = ["lightning", 0];
  graph["480"].inputs.device = "auto";
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
