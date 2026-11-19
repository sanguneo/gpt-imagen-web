import { expect, test } from "bun:test";
import { mossWorkflow } from "./moss-workflow.mjs";

test.each([[512, 512, 42], [832, 1248, 0], [2048, 256, Number.MAX_SAFE_INTEGER]])(
  "MOSS native workflow honors %ix%i and seed %i",
  (width, height, seed) => {
    const graph = mossWorkflow({ prompt: "fictional adult portrait", negative: "blurry", width, height, seed, prefix: "moss_contract" });
    // Independent installed release contract: native ConvRot, never GGUF.
    expect(graph["1"]).toEqual({ class_type: "UNETLoader", inputs: { unet_name: "moss_image_sft_int8_convrot.safetensors", weight_dtype: "default" } });
    expect(graph["2"].inputs).toEqual({ clip_name: "qwen3.5_9b_int8_convrot.safetensors", type: "moss_image", device: "default" });
    expect(graph["3"].inputs.vae_name).toBe("flux2-vae.safetensors");
    expect(graph["4"].inputs).toEqual({ model: ["1", 0], lora_name: "MOSS-Image-NSFW-Uncensored-LoRA-ComfyUI.safetensors", strength_model: 0.8 });
    expect(graph["5"].inputs).toEqual({ clip: ["2", 0], text: "moss_xvstyle, fictional adult portrait" });
    expect(graph["6"].inputs).toEqual({ clip: ["2", 0], text: "blurry" });
    expect(graph["7"].inputs).toEqual({ width, height, batch_size: 1 });
    expect(graph["8"].inputs).toEqual({ model: ["4", 0], double_layers: "", single_layers: "22", start_percent: 0, end_percent: 0.5 });
    expect(graph["9"].inputs).toEqual({
      model: ["8", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0],
      seed, steps: 30, cfg: 3, sampler_name: "euler", scheduler: "simple", denoise: 1,
    });
    expect(graph["10"].inputs).toEqual({ samples: ["9", 0], vae: ["3", 0] });
    expect(graph["11"].inputs).toEqual({ images: ["10", 0], filename_prefix: "moss_contract" });
  },
);

test.each([
  ["moss_xvstyle, adult portrait", "moss_xvstyle, adult portrait"],
  ["moss_xvstylefake", "moss_xvstyle, moss_xvstylefake"],
])("MOSS trigger remains a complete token for %s", (prompt, expected) => {
  expect(mossWorkflow({ prompt, negative: "", width: 512, height: 512, seed: 1, prefix: "moss" })["5"].inputs.text).toBe(expected);
});
