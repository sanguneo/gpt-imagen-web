# MOSS-Image in the web app

The web model `moss-image` uses the existing authenticated Mac job service and
its serial queue, shared with both Qwen options. It loads the installed
MOSS-Image SFT int8 model, Qwen3.5 int8 text encoder, Flux2 VAE and
MOSS uncensored LoRA at strength 0.8. The generator adds the `moss_xvstyle`
trigger automatically.

MOSS accepts a text prompt, negative prompt, output size and optional seed.
Reference images are rejected by both the web and Mac service boundaries.
`auto` means 512x512 for MOSS; existing Qwen defaults are unchanged.
The Mac generation process has a 30-minute limit. The web observer allows
35 minutes after generation starts so it can receive the service's terminal
status. Queue time does not consume that generation budget.

Submit through the same multipart endpoint as the form:

```sh
curl -i http://127.0.0.1:8787/api/generate \
  -F imageModel=moss-image -F size=512x512 -F seed=42 \
  -F 'prompt=A studio portrait of a fictional adult wearing a navy sweater'
```

The response is HTTP 202 with `entry.id`. Follow
`GET /api/history/:id` until `entry.status` is `done` or `error`;
download `entry.imageUrl` on success. History, restart recovery and retries
retain the MOSS model identity.

Install the shipped MOSS service files beside the existing Mac service and
restart the service only while its queue is idle. Existing Qwen files and
model weights must remain in place. No additional listener, token or queue
is required. No weights are included in this repository.

This is intentionally a web-only integration, matching the existing Qwen
deployment. The CLI, Node SDK and Python SDK do not accept local Mac model
IDs; their existing model validation continues to reject them.
