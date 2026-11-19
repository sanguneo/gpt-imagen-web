// Native ConvRot workflow proven against the installed ComfyUI MOSS nodes.
export function mossWorkflow({ prompt, negative, width, height, seed, prefix }) {
  return {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "moss_image_sft_int8_convrot.safetensors", weight_dtype: "default" } },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3.5_9b_int8_convrot.safetensors", type: "moss_image", device: "default" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "flux2-vae.safetensors" } },
    "4": { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: "MOSS-Image-NSFW-Uncensored-LoRA-ComfyUI.safetensors", strength_model: 0.8 } },
    "5": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: /^moss_xvstyle\b/.test(prompt) ? prompt : `moss_xvstyle, ${prompt}` } },
    "6": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: negative } },
    "7": { class_type: "EmptyFlux2LatentImage", inputs: { width, height, batch_size: 1 } },
    "8": { class_type: "SkipLayerGuidanceDiTSimple", inputs: { model: ["4", 0], double_layers: "", single_layers: "22", start_percent: 0, end_percent: 0.5 } },
    "9": { class_type: "KSampler", inputs: { model: ["8", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0], seed, steps: 30, cfg: 3, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
    "10": { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["3", 0] } },
    "11": { class_type: "SaveImage", inputs: { images: ["10", 0], filename_prefix: prefix } },
  };
}
