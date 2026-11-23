# Qwen-Image 2.1 Lightning v2-RL generator

The adjacent `gen.mjs`, `gen.sh`, `lightning.mjs` and `workflow_api.json` are
source snapshots of the Mac installation at `~/qwen-image/`. Keep them identical
when installing. The existing ComfyUI, Python environment, base GGUF, text encoder
and VAE are prerequisites; this directory is not a standalone model bundle.

Normal `gen.sh "prompt" 512x512` retains 35 steps, CFG 5, er_sde/simple and the
existing reference-size behavior. Add `--fast` for the fixed 4-step preset:

```sh
~/qwen-image/gen.sh --fast --seed 42 "A red teapot" 512x512
~/qwen-image/gen.sh --fast --ref reference.jpg "Edit this image" 832x1248
```

`--fast` cannot combine with `--steps`, `--cfg`, `--sampler` or `--scheduler`.
Negative text is accepted but has no classifier-free guidance effect at CFG 1.
The normal workflow JSON is unchanged. Fast mode inserts `LoraLoaderModelOnly`
after `UnetLoaderGGUF`, enables the lossless prefix KV cache (`auto` device), and
uses native `SamplerCustom`, `KSamplerSelect` (Euler) and `ManualSigmas`.
ComfyUI-GGUF applies quantized LoRA patches during dequantization; no base model
conversion or destructive weight merge is needed.

Official source:
`https://huggingface.co/lightx2v/Qwen-Image-2.1-Lightning-v2-RL`

Pinned revision: `682b2529ffb5ae9ba39ceb81a31ce99e602da2ee`.
Download only `qwen_image_21_lightning_v2_rl_4steps_lora_rank64.safetensors`
from that revision and keep that filename in `~/qwen-image/models/loras/`.
Size: 688,056,648 bytes. The adjacent SHA256SUMS records the official LFS SHA256.
The LoRA metadata identifies it as a rank-64 reconstruction of the RL transformer.
The full transformer is not needed for this GGUF/LoRA installation.
This is the Qwen-Image **2.1** adapter; older Qwen-Image Lightning adapters are
not interchangeable.

The pinned `inference_config.json` uses `[1, 0.95418, 0.89508, 0.704534]`,
then terminal zero, with Euler sampling and CFG 1. These release sigmas are
already shifted. Do not apply dynamic shifting or terminal stretching again.
The scheduler has 1000 training timesteps, shift 1, and no stochastic, inverted,
beta, exponential or Karras sigma transformation. `ManualSigmas` supplies the
release schedule directly, independent of image dimensions.
Reference-sized output still uses the first reference latent from
`TextEncodeQwenImage21`; a separate image-size probe is no longer needed.
MPS/GGUF numerics are not promised to match the BF16 CUDA examples bit for bit.

## Rollback from v2-RL

Before replacing v1, preserve its 67,144,280-byte LoRA under
`models/loras/qwen-image-2.1-lightning-v1-4step.safetensors`.
Its original LFS SHA256 remains in SHA256SUMS. Keep the old `gen.mjs` and
`lightning.mjs` together as a rollback pair. To roll back, restore that pair
and restore the LoRA filename expected by the v1 loader:
`qwen-image-2.1-lightning-4step.safetensors`. Changing only the LoRA while
retaining the v2 sigma schedule does not restore v1 behavior.

## License verification

The pinned v2-RL model card declares `license_name: qwen-research` and links
to the base model license. Do not describe the weights as Apache/MIT based
on the LightX2V software license. `Qwen/Qwen-Image-2.1` supplies the
**Qwen RESEARCH LICENSE AGREEMENT**, dated September 20, 2026:
`https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE`.
Section 2 limits the grant to noncommercial research/evaluation; commercial use
requires a separate license. These checks do not establish a commercial license
for the adapter. No model weights are included in this repository.

Local fake-service and workflow checks:

```sh
bun test --timeout 20000 ./qwen-service/service-check.mjs ./qwen-service/lightning-check.mjs
```
