# Mac Qwen service unit

The adjacent `service.mjs` is the source snapshot for review and packaging. It must
remain byte-identical to `~/qwen-image/service.mjs`. Installation, launchd, token
creation, OCI configuration and real generation are the parent's responsibility.

The generator source snapshots and pinned 2.1 Lightning v2-RL installation, schedule
and license notes are documented in [lightning.md](./lightning.md).

Run the service with Bun on macOS. Configure:

| Variable | Default / meaning |
| --- | --- |
| `QWEN_HOST` | Required literal tailnet address; IPv4 `100.64.0.0/10` or IPv6 `fd7a:115c:a1e0::/48`. No wildcard, DNS or LAN binding. |
| `QWEN_PORT` | `8789`; `0` requests an ephemeral port. |
| `QWEN_TOKEN_FILE` | `~/qwen-image/service.token`, private mode 600, one Bearer token. |
| `QWEN_JOBS_DIR` | `~/qwen-image/jobs`; may select a private persistent volume. One service owns each store. |
| `QWEN_GENERATOR` | `gen.sh` next to the service. Absolute executable path; deployment may select an existing generator installation. Its `output/` directory must be adjacent. Trusted operator configuration only. |

All routes require `Authorization: Bearer <token>`. Tokens are loaded once at
startup and never printed. Comparison hashes both header values to fixed-length
SHA-256 digests and uses timing-safe equality. No CORS is enabled.

`POST /jobs` accepts multipart fields `prompt`, `negative`, `size`, `seed`,
`requestId`, `mode`, and repeatable file field `images` (0..16). JSON accepts the same
scalar fields and no references. `mode` is optional, exactly `normal`, `fast`, `krea2` or `krea2-fast`;
omitted means `normal`. Any other value, type or duplicate field returns 400. The
mode is stored in the job input, and the generator receives `--fast` (after any
`--ref` options, before `--`) only for `fast`. Krea jobs receive `--model krea2`
and reject references with 400. `krea2-fast` additionally passes `--fast`.
See [krea2.md](./krea2.md) for weights and settings.
Durable jobs written before this
field existed have no mode and run as `normal`. `prompt` is nonempty, up to 60000 characters;
`negative` defaults to empty and has the same cap. `size` is required `WxH`, both
sides 256..2048, multiples of 32. `seed` is optional, a nonnegative safe integer
(decimal text in multipart). `requestId` is optional, exactly 20 lowercase hex
characters. A repeated key returns the original `{id}` even if its job failed or
its fields differ. Keys remain reserved for the lifetime of retained job records.
Concurrent submissions with one key commit one job. Successful POST returns
202 `{id}` only after durable commit.

Reference types are PNG, JPEG, WebP and GIF, checked using file signatures and Bun's
normalized file MIME type (Bun can infer this from bytes rather than the submitted
Content-Type).
Each file is at most 12 MiB and total reference bytes at most 64 MiB. The HTTP
body cap is 65 MiB including multipart overhead. Signature checks do not decode
or verify full image contents; the generator owns decoding.
GIF bytes and extension are preserved. The installed ComfyUI `LoadImage` uses
`VideoFromFile` (PyAV) and Pillow; both installed decoders accept GIF. Animated
references follow ComfyUI's existing frame handling; the service does not
flatten or transcode them. This was checked with a tiny local GIF, without model
generation. Full animated-GIF generation remains untested.

`GET /jobs/:id` returns `{id,status,stage,queuePosition,mode,createdAt,startedAt,
finishedAt,error}`. Status is `queued`, `running`, `done` or `error`. Stages are
plain descriptions (`queued`, `generating`, `done`, `error`); no synthetic
percentage or estimated time is exposed. Queue position is one-based when queued,
zero otherwise. Timestamps are ISO UTC; unavailable timestamps and errors are
null. `GET /jobs/:id/image` serves the private durable PNG after completion,
otherwise 409. Unknown routes/jobs return 404; missing or wrong auth returns 401.
Invalid fields return 400, unsupported content types 415, oversized bodies 413.

One generator process group runs at a time. Each invocation runs through an
explicit Perl alarm of 7800 seconds (130 minutes) and `caffeinate -i`; queue wait
does not consume that budget. The existing generator also has its own 120-minute
generation deadline. Prompt/options are argv elements, never shell interpolation.
Stdout must contain exactly one absolute path resolving inside the generator's
adjacent `output/`; only PNG output is copied to the job store.

Each committed job has `job.json`, uploaded refs, `stdout.log`, `stderr.log` and,
after success, `image.png`. Atomic writes fsync the file, rename and fsync the
directory. Incomplete `.pending-*` submissions are ignored after restart.
Queued jobs resume; running jobs become errors and are never generated again.
Completed images are served from the job store, independent of original output.
An OS-released SQLite exclusive lock prevents two service owners. Shutdown kills
the complete child process group. A Perl supervisor also detects parent loss;
the group PID is durably committed before allowing generation to start.
Startup never signals a historical PID, since it may have been reused. A second
OS-released generation lock held by the supervisor serializes across an immediate
service restart until the previous supervisor exits after detecting parent loss.

Do not manually run `gen.sh` concurrently with this service: its memory queue
covers service jobs only. Persistent jobs, refs, logs, idempotency keys and images
are retained indefinitely; the parent must choose a retention policy and preserve
metadata with images. Back up the whole store when the service is stopped.

The PR includes `qwen-service/service-check.mjs`, a copy of
`~/qwen-image/service.test.mjs`. Its filename and location keep Bun-specific tests
outside Node's default `node --test` discovery. It resolves the service relative
to itself, so this snapshot tests the adjacent packaged `service.mjs`.

From the repository root, run `bun test ./qwen-service/service-check.mjs`.
For a bounded run with the suite's explicit test timeout:

```sh
perl -e 'alarm 180; exec @ARGV' caffeinate -i bun test --timeout 20000 ./qwen-service/service-check.mjs
```

Tests bind the active tailnet
interface on ephemeral ports and use only temporary local fake executables;
they never contact ComfyUI or a model API. An active IPv4 tailnet interface is
required. `QWEN_GENERATOR` is a production executable configuration, used here to
exercise the real subprocess, persistence and HTTP boundaries without generation.
