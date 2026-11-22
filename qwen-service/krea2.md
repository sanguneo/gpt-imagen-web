# Krea 2 Raw with Verite realism

`gen.sh --model krea2 "a cat on a sofa" 512x512` selects the text-only Krea
workflow. The service accepts `mode=krea2` in JSON and multipart. Qwen normal
and Lightning v2-RL fast generation keep their existing presets.

The Verite LoRA has strength 1. If none of its three triggers is present
(case insensitive), the generator prepends `Candid amateur photo, `.
The other recognized triggers are `Amateur phone photo` and `Candid flash photo`.
Reference images and sampler overrides are rejected for this fixed preset.
Trigger recognition requires complete phrases: `photographer` and `photography`
do not count as the trigger word `photo`.

Run `bun test --timeout 20000 ./qwen-service/krea2-check.mjs` from the repository
root to check the generated ComfyUI prompt at the real CLI/HTTP boundary.
This suite owns port 8188 briefly and must run without a real ComfyUI generation.

## Pinned files

Place these under the generator's `models/` directory. Downloaded weights must
match the SHA256 entries in `SHA256SUMS`; weights are never checked into Git.

| Source | Revision | File |
| --- | --- | --- |
| Comfy-Org/Krea-2 | 588feaf955b08b9ac4723eeb751752ab045dba71 | diffusion_models/krea2_raw_fp8_scaled.safetensors |
| Comfy-Org/Krea-2 | 588feaf955b08b9ac4723eeb751752ab045dba71 | text_encoders/qwen3vl_4b_fp8_scaled.safetensors |
| Comfy-Org/Krea-2 | 588feaf955b08b9ac4723eeb751752ab045dba71 | vae/qwen_image_vae.safetensors |
| f23gg/Krea-2-NSFW-V5 | 45263ccb4d3072f48746811edbf7a94faa3ca839 | loras/Verite_realism.safetensors |

The realrebelai GGUF card names Base, while its base-model metadata names Turbo,
and does not identify BASE as Raw. Use the explicitly named Comfy-Org Raw repack.
The LoRA card identifies Krea-2-Raw and specifies the triggers, but no strength
recommendation or separate license.

## Sampling

The current Comfy-Org templates expose Turbo, not a separate Raw template.
The workflow uses their UNETLoader, Krea2 CLIPLoader, Qwen Image VAE, Euler and
simple scheduler topology, with the official krea-ai/krea-2 README's Raw
recommendation of 52 steps and guidance 3.5. In that reference sampler the
formula is `cond + guidance * (cond - uncond)`, so ComfyUI CFG is **4.5**.
ModelSamplingFlux reproduces the reference's resolution-dependent mu endpoints
of 0.5 at 256px and 1.15 at 1280px. It uses equal base/max shifts after computing
mu, avoiding the Flux node's different interpolation endpoints. Prompt expansion
is off so the supplied prompt and trigger reach the encoder directly.

## License notes

Comfy-Org declares the Krea 2 Community License and supplies LICENSE.pdf.
The Krea source repository separately licenses its code under Apache 2.0;
that does not replace the weight license. The community license names Raw
and Turbo, includes a commercial revenue threshold and deployment/distribution
conditions. The Verite repository has no separate license declaration.
These notes do not establish a separate commercial grant for the LoRA.
