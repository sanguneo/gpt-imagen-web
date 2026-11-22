# Local Qwen web integration

This provider is intentionally available only in the tailnet web application.
The existing Codex CLI, Node SDK and Python SDK contracts are unchanged.
Qwen uses an asynchronous job protocol, rather than the Codex authenticated API.

The deployed web application and its GPT 2.5/2.6 support were present on OCI as
uncommitted files at upstream revision 27db3d9. This change preserves those
sources so the web application is reproducible from this repository.

UI brief: the primary action remains "생성 시작". Reading priorities are prompt,
model and size/reference controls, then progress and saved results. The local
options follow the existing four GPT options: Qwen normal, Qwen 4-step fast,
then `Krea 2 실사` (Raw) and `Krea 2 빠름`. The local options show negative
prompt and seed. Both Krea 2 modes hide the reference field. Both fast modes
show a one-line hint that negative prompt has little effect at CFG 1; the hint is linked to the field with
`aria-describedby` only while it is visible. Existing form fields, history,
details, retry, and IPMPT save actions remain available. No new layout or
visual style is introduced. The existing field, row, message, card, detail and
pickerSearch primitives and the `web/public/style.css` palette, spacing and
typography are reused; the hint adds one `hint` primitive that takes the
label's size and colour at regular weight. Left out on purpose: time estimates
or speed claims for the fast option, which has no measurements yet.

Layout: retain the existing document scroller and responsive form grid;
Qwen options use the same row/field primitives; modal details own their scroll.

Set `QWEN_SERVICE_URL` and `QWEN_SERVICE_TOKEN_FILE` in the OCI service
environment. The file must contain the shared Bearer token and be mode 600.
Neither value belongs in version control. `QWEN_JOB_TIMEOUT_MS` defaults to
125 minutes and cannot be set below 120 minutes; Mac queue time is excluded.
Each fetch is limited to 30 seconds, generation is asynchronous, and a stable
imagegen history ID is the remote idempotency key.

Imagegen resumes unfinished Qwen jobs after restart without resubmitting a
second generation. Mac service restart marks an interrupted generation as an
error; completed images and queued jobs remain durable. Manual retry creates
a new job. Qwen jobs have their own web tracking map so waiting on the Mac does
not occupy the existing Codex concurrency slots.

`qwen-image-2.1`, `qwen-image-2.1-fast`, `krea2`, and `krea2-fast` share the Mac service job
creation, retry, restart recovery, progress, history and details. The history
entry stores the selected model, and each submission derives the Mac service
`mode` from it: respectively `normal`, `fast`, `krea2`, and `krea2-fast`. A job
resubmitted after a restart therefore keeps its original mode. `mode` is always
sent, so the Mac service must accept the requested mode. The Qwen models are
saved to IPMPT as "Qwen-Image 2.1"; the Krea 2 modes use their respective web labels.

Qwen auto size means 1024x1024. Each side must be 256–2048 and a multiple of
32. The web form offers 512x512 for a shorter run. Existing GPT sizes remain
unchanged. Negative prompt and optional integer seed are forwarded for all
four local modes. Both Qwen modes forward attached reference images up to
the web app's configured limit. `krea2` and `krea2-fast` are text-to-image only; the generation
endpoint rejects reference image uploads with HTTP 400.

Estimated times come from this Mac's prior measurements: about 7 minutes for
512x512, 28 minutes for 1024x1024 and over an hour for some reference jobs.
The UI shows elapsed time, actual stage and queue position rather than a
fabricated completion percentage. Active Qwen jobs refresh every five seconds.
These timings belong to the normal Qwen model. Fast Qwen and Krea 2 report no estimate
(`estimatedTime` is null), so its progress line shows only the two-hour limit
and their form guidance omits the timing sentence.
