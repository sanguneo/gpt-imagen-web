# Qwen-Image 2.1 Lightning generator

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
after `UnetLoaderGGUF`, disables the prefix KV cache as in the model card, and
uses native `SamplerCustom`, `KSamplerSelect` (Euler) and `ManualSigmas`.
ComfyUI-GGUF applies quantized LoRA patches during dequantization; no base model
conversion or destructive weight merge is needed.

Official source:
`https://huggingface.co/lightx2v/Qwen-Image-2.1-Lightning`

Pinned revision: `6b0a1176327c01522a44276c5da67331a025b6fc`.
Download `pytorch_lora_weights.safetensors` from that revision and save it as
`~/qwen-image/models/loras/qwen-image-2.1-lightning-4step.safetensors`.
Size: 67,144,280 bytes. The adjacent SHA256SUMS records the official LFS SHA256.
This is the Qwen-Image **2.1** adapter; older Qwen-Image Lightning adapters are
not interchangeable.

The official training schedule uses `[1, 0.75, 0.5, 0.25]`, then zero, with
dynamic exponential shifting and no terminal stretching. The token count is
`width * height / 256`; mu interpolates linearly from 0.5 at 256 tokens to 0.9 at
8192 tokens. Each nonzero sigma becomes `exp(mu)/(exp(mu)+(1/sigma-1))`.
For reference-sized output, the generator uses the first image's EXIF-aware
dimensions and the same resize/rounding as `TextEncodeQwenImage21`.
MPS/GGUF numerics are not promised to match the BF16 CUDA examples bit for bit.

## License verification

The pinned adapter repository and model card do **not** declare a separate
license or contain a LICENSE file. Do not describe this adapter as Apache/MIT
based on the LightX2V software license.

Its declared base model `Qwen/Qwen-Image-2.1` supplies the
**Qwen RESEARCH LICENSE AGREEMENT**, dated September 20, 2026:
`https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE`.
Section 2 limits the grant to noncommercial research/evaluation; commercial use
requires a separate license. These checks do not establish a commercial license
for the adapter. No model weights are included in this repository.

Local fake-service and workflow checks:

```sh
bun test --timeout 20000 ./qwen-service/service-check.mjs ./qwen-service/lightning-check.mjs
```
