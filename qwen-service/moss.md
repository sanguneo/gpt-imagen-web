# MOSS-Image SFT on the Mac

CLI: `gen.sh "A cafe sign" 512x512 --model moss`.
Service: `mode=moss`; JSON is text-only, multipart accepts zero to four
`images` files through the existing reference transport. Prompt text, including
serialized JSON layouts, passes unchanged. Preset overrides and `--fast` are
rejected for this mode.

SFT is public and Apache-2.0, like Base. It uses the same architecture and the
card demonstrates cleaner text grouping. Official model revision:
`OpenMOSS-Team/MOSS-Image-SFT@f972bd4b4b9e3852133cc5da954d87bc32cd8fb9`.

The official plugin was audited before installation and pinned to
`OpenMOSS/MOSS-Image@6be4453024c5acae9dcd0a191e26ee524e743310`, version
0.1.1. Its declared dependency list is empty. The plugin reads local
safetensors, JSON and tokenizer files; its Hugging Face tokenizer call sets
`local_files_only=True`. No telemetry, subprocess calls or runtime code downloads
were found. The bundled Diffusers pipeline was also read; it loads model
components with library `from_pretrained` calls and has no unrelated network
client or telemetry. It is not executed by this installation.

Current official instructions recommend native ComfyUI loaders. The workflow
uses the already-installed native MOSS implementation, including its real edit
conditioning path, rather than the older plugin transformer's text-only model.
No core ComfyUI update or additional Python dependency is required.

Weights are from `Comfy-Org/MOSS-Image` revision
`2929efe3cdd506c0a430bcfca70a9a8d805cc095`, whose card declares Apache-2.0:

| Path below models/ | Bytes |
| --- | ---: |
| diffusion_models/moss_image_sft_int8_convrot.safetensors | 5413698958 |
| text_encoders/qwen3.5_9b_int8_convrot.safetensors | 9748121532 |
| vae/flux2-vae_small.safetensors | 249521340 |
| loras/moss_image_edit_lora_rank_64_bf16.safetensors | 297382216 |

The 32 GiB Mac has no CUDA. INT8 storage totals about 14.6 GiB including the
optional edit adapter, compared with about 27.5 GiB for BF16 transformer and
encoder alone. Small ConvRot INT8 linear operations were tested on CPU and MPS
before downloading. This is a storage and operation check; the real service
smoke result is recorded in the owner's work report.

Text-only follows the official API workflow: Euler, `sgm_uniform`, 50 steps,
CFG 3, shift 5 through native ModelSamplingAuraFlow (timestep multiplier 1),
negative-branch skip of single block 22, empty default negative
prompt, Flux2 latent and small Flux2 VAE.

Base and SFT themselves expose no reference argument. Image editing is a
community LoRA by `chinoll/Moss-Image-Edit`, repackaged by Comfy-Org, with native
`TextEncodeMOSSImageEdit` support. It is not an OpenMOSS edit checkpoint.
With references, load this adapter at strength 1 and encode all references into
both positive and negative conditioning with `edit_format=Moss-Image-Edit`.
The official Comfy edit template uses Euler/normal, 30 steps, CFG 4, block 22
negative skip and the native model's shift 5. Its default negative prompt is
`nsfw, worst quality, bad anatomy, watermark, jpeg artifact`. Explicit output
dimensions follow the existing service contract; references retain their
original dimensions. Tests and first smoke use 512px fictional content.

Sources:
- https://github.com/OpenMOSS/MOSS-Image/blob/6be4453024c5acae9dcd0a191e26ee524e743310/comfyui/README.md
- https://huggingface.co/OpenMOSS-Team/MOSS-Image-SFT
- https://huggingface.co/Comfy-Org/MOSS-Image
- https://huggingface.co/chinoll/Moss-Image-Edit
- https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_moss_image_edit.json
