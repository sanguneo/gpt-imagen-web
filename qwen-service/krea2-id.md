# Krea 2 Identity Edit V2

`--model krea2-id --ref path/to/reference.jpg` and service `mode=krea2-id`
require exactly one reference. JSON requests have no reference transport and fail
with 400; use the existing multipart `images` field. Existing Qwen references and
Krea text-only presets are unchanged. Explicit output sizes are supported; the
CLI defaults to 1024x1024 for identity edits when no size is supplied.

The V2 model card's single-person restaging preset uses the actual Turbo base,
8 steps, CFG 1, Euler/simple, identity LoRA strength 1, ref_boost 2,
grounding_px 768, placement `beside (right of target)`, and fit geometry.
Both grounded encoding and VAE appearance paths receive the same image.
The pixel path receives the sampler's target latent to encode before sampling.
The default workflow does not stack the turbo or Verite LoRAs.
Negative input is retained, but CFG 1 does not apply negative guidance.

Node pack: `lbouaraba/comfyui-krea2edit` tag `v2.0.0`, commit
`13ef60f20828949becada815d3cbc371eb5ccaab`. Reviewed runtime `__init__.py`
contains only local tensor/model/encoding operations and local version reads:
no outbound network, telemetry, subprocess execution, or code downloads.
`pyproject.toml` declares `dependencies = []`; no packages are installed.

Weights (SHA256 in the adjacent manifest):

- `conradlocke/krea2-identity-edit` revision
  `f33b26291c640e8ec50b0da420bfee3c9a660daa`,
  `krea2_identity_edit_v2_r64.safetensors`, 457,140,008 bytes.
- `Comfy-Org/Krea-2` revision
  `588feaf955b08b9ac4723eeb751752ab045dba71`,
  `diffusion_models/krea2_turbo_fp8_scaled.safetensors`, 13,141,730,784 bytes.
- The existing Qwen3-VL 4B encoder and Qwen image VAE are reused.

V2 weights are free for personal/non-commercial use under `LICENSE_V2.md`
and also subject to the Krea 2 Community License, `LICENSE.pdf`, and `NOTICE`.
Commercial use needs the author's separate written license. Nodes are Apache-2.0.
The mode is a Mac service/web integration; it does not add a remote provider to
the GPT image SDK or its Python client.

Run `bun test --timeout 20000 ./qwen-service/service-check.mjs
./qwen-service/krea2-id-check.mjs` from the repository root. Test fixtures are
synthetic; private reference photos and model weights must not enter Git.
