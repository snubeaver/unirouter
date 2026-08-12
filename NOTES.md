# Phase 1 — Serve: notes and decisions

## Environment
- Host: Jeffui-Mac-Studio.local, macOS 14.2 (Sonoma), arm64, 32GB unified memory
- Installed: Homebrew, tmux (session `inference`, windows: claude/vllm/bench),
  Python 3.12.12 (arm64, via `~/.local/bin/python3.12`)
- vLLM Metal plugin installed via official installer into `~/.venv-vllm-metal`
  (vllm==0.26.0+cpu core wheel + vllm-metal==0.3.0.dev20260810145134, MLX backend)
- Model: `openai/gpt-oss-20b` downloaded from Hugging Face (unauthenticated,
  no HF_TOKEN set), 38GB on disk (includes bf16 `original/` weights, MXFP4
  safetensors, and an MLX-converted `metal/` copy) — cached at
  `~/.cache/huggingface/hub/models--openai--gpt-oss-20b`

## Blocker: vllm-metal prebuilt Metal kernels incompatible with macOS 14.2

`vllm serve openai/gpt-oss-20b --port 8000` (default flags) fails to fully
init the engine:

```
RuntimeError: [metal::Device] Unable to load function reshape_and_cache_kv_bfloat16_t_cache_bfloat16_t
error: air version set to 2.7.0 (...), but expecting 2.6
```

Root cause: vllm-metal ships precompiled `.metallib` kernels (paged
attention, KV cache ops) built against a newer Metal toolchain (AIR 2.7)
than macOS 14.2's Metal runtime supports (AIR 2.6). This is an OS-level
Metal runtime gap, not something `xcode-select --install` / updating
Command Line Tools alone fixes (CLT 15.3.0 is already installed).

`softwareupdate --list` shows two updates available:
- macOS Sonoma 14.8.9 (point release, same major version — likely does NOT
  bump the Metal AIR ceiling)
- macOS Tahoe 26.6.1 (major version upgrade — most likely required to get
  a Metal runtime new enough for vllm-metal's current prebuilt kernels)

**Did not perform any OS upgrade** — this is a significant, hard-to-reverse
system change on a machine used for daily SSH access and long-running work,
so it needs a decision from Jeffui, not a unilateral call.

### Workaround attempted: `VLLM_METAL_BUILD_FROM_SOURCE=1`

vllm-metal supports compiling its Metal shaders locally at runtime via MLX
instead of loading the prebuilt `.metallib` (docs: "No Metal toolchain
needed: MLX compiles the .metal shaders in-process"). This avoids the AIR
version crash — the server starts and serves correctly (`/v1/models`,
streaming chat completions, and `usage` token accounting via
`stream_options.include_usage` all verified working with
`--max-model-len 32768`).

**However, this path is not performance-viable**: generation throughput
observed was ~0.1–0.2 tokens/s (i.e., several seconds per token) via the
server's own logged `Avg generation throughput`. A 3-run TTFT/tok-s
benchmark (256 max_tokens, temperature 0) did not complete within 3 minutes
per run and was killed. This looks like the JIT-compiled fallback path is
missing the fused/optimized paged-attention kernel path that the prebuilt
`.metallib` provides (not just "slightly slower" — 100x+ off from expected
M2 Max throughput for a 20B MXFP4 model).

### Also hit and fixed independently
- Default `vllm serve` picked up the model's full 131072 context length,
  which needs 6.0GiB KV cache vs 5.22GiB available under default
  `gpu_memory_utilization` — capped with `--max-model-len 32768` (fits
  comfortably: 8177 KV cache blocks, ~4x concurrency headroom at 32k/req).
  This is unrelated to the AIR mismatch and stays regardless of how the
  Metal kernel issue is resolved.

## Update 2026-08-11: unblocked — macOS upgraded to Tahoe 26.6.1

Host OS is now macOS 26.6.1 (Tahoe), build 25G76 (upgraded outside this
session — not something this session performed). This resolves the AIR
2.7 vs 2.6 Metal kernel mismatch: `vllm serve openai/gpt-oss-20b --port
8000 --max-model-len 32768` (no `VLLM_METAL_BUILD_FROM_SOURCE` workaround)
now logs `Native paged-attention Metal kernels loaded` and starts cleanly.
Option 1 from the list below is what happened; options 2/3 are moot.

### Streaming format gotcha (relevant to router work in Phase 2)

gpt-oss's harmony format splits streamed output across two delta fields:
`delta.reasoning` (chain-of-thought) arrives first and for many tokens,
`delta.content` (the final-channel answer) arrives later, sometimes not
at all within `max_tokens` if the budget is consumed by reasoning. Usage
accounting (`completion_tokens`) counts both. Any router/proxy logic that
only watches `delta.content` will under-detect "first token" and can miss
responses entirely when reasoning eats the whole budget — measure TTFT
against first token of *either* field, not just `content`.

Also: the `usage` chunk in the SSE stream can arrive in a frame with an
empty `choices: []` — don't skip usage extraction inside a `if not
choices: continue` guard, check usage first.

### Real benchmark numbers (single RTX-free M2 Max, Metal, gpt-oss-20b, MXFP4)

3x sequential single-stream requests, temp=0, 256 max_tokens, warm server
(first request after startup pays a ~1.4s extra one-time cost, excluded
below):

| metric | value |
|---|---|
| TTFT (first token, incl. reasoning) | ~0.19s |
| TTFT to first content/answer token | ~1.0s |
| Steady-state generation throughput | ~58 tok/s |

Concurrency (4 distinct prompts, `stream_options.include_usage`):

| concurrency | per-req tok/s | aggregate tok/s | ideal linear (n×58) |
|---|---|---|---|
| 1 | 58 | 58 | 58 |
| 2 | 26–34 | 51 | 116 |
| 4 | 20 | 73 | 232 |

Confirms the expected batch-throughput weakness vs CUDA: aggregate
throughput grows sub-linearly and per-request latency degrades noticeably
under concurrency (one req at concurrency=4 wasn't first-content-token
done at all within the measurement window). Recorded honestly per
CLAUDE.md's measurement-plan item 1 — no attempt made to hide or smooth
this.

### Status: Phase 1 serving is now unblocked and functional

Core vLLM serving (streaming + usage tokens) is verified working
end-to-end on real hardware with real kernels.

## Router scaffold: `/models` endpoint (2026-08-11)

Created `router/` — TypeScript + Hono, plain Node process (not Cloudflare
Workers, per CLAUDE.md — needs localhost:8000 access), runs on port 3402
via `npm run start` (tmux window `inference:bench` during dev). No
proxying/completions routing yet — Phase 1 only calls for the `/models`
metadata endpoint; the actual request-routing logic (~50 lines, local vs.
upstream table + health-check fallback) is deferred to when there's an
actual second upstream to route to.

- `router/src/config.ts`: pricing + upstream table live here, not scattered
  through handlers. `FEE_BPS = 0` (never hardcoded elsewhere, per
  CLAUDE.md). Local model pricing is the fixed hybrid schedule from
  CLAUDE.md ($0.0001 floor + $0.03/$0.13 per 1M in/out); NOT further
  marked up by fee_bps — only upstream cost pass-through gets the fee_bps
  markup, per CLAUDE.md's "Paid upstreams: cost pass-through + fee_bps
  markup" wording.
- `UPSTREAMS` array is intentionally empty — no NVIDIA / DeepSeek /
  OpenRouter keys exist yet (no `.env` file on this host), and which paid
  upstream to use is still undecided per CLAUDE.md. Each `UpstreamEntry`
  carries `tier`, `kill_switch` (env var name), and `rate_limit_rpm` per
  the "Upstream constraints" spec — `isUpstreamEnabled()` checks the env
  var directly, so an upstream is automatically "disabled" in `/models`
  until its key is actually added to `.env`. Nothing to change in code to
  enable/disable at runtime.
- `/models` live-health-checks local vLLM via `GET localhost:8000/health`
  (1.5s timeout) and reports `status: "available"` / `"unavailable"`
  accordingly — verified: returns `"available"` with vLLM running.

Verified output (vLLM running):
```json
{
  "object": "list",
  "data": [{
    "id": "openai/gpt-oss-20b", "object": "model", "context_length": 32768,
    "pricing": {"request": "0.0001", "prompt": "0.00000003", "completion": "0.00000013"},
    "top_provider": {"tier": "local"}, "status": "available"
  }],
  "_router": {"fee_bps": 0}
}
```

Next Phase 1 candidate: none — `/models` was the last stated Phase 1
deliverable. Phase 2 (Pay) is the next phase per CLAUDE.md.

## Upstream expansion beyond CLAUDE.md's "1-2 paid upstreams" scope note (2026-08-11)

Decision, made explicitly with Jeffui: add OpenAI and Anthropic as direct
upstreams (not via OpenRouter), plus DeepSeek direct and (pending) NVIDIA
beta-free catalog Chinese open models. This exceeds CLAUDE.md's original
"1-2 paid upstreams (DeepSeek direct or OpenRouter credits)" scope note —
flagging here rather than silently deviating. The "routing logic v1 is
deliberately dumb... ~50 lines" principle still holds structurally (one
`/v1/chat/completions` handler, table-driven dispatch); Anthropic needed a
translation layer (`router/src/providers/anthropic.ts`) since its native
`/v1/messages` API isn't OpenAI-shaped — everything else (OpenAI, DeepSeek)
is a straight passthrough.

Implemented in `router/src/index.ts` + `router/src/config.ts`:
- `POST /v1/chat/completions`: matches `model` against `LOCAL_MODEL.id`
  (proxy to localhost:8000, 503 if health check fails — no silent reroute
  to a paid upstream on local failure, since that would spend real money
  without the caller's awareness) or the `UPSTREAMS` table (404 if
  unknown, 503 if the upstream's `kill_switch` env var isn't set, 429 if
  the per-upstream RPM cap is hit).
- Verified end-to-end with local model (chat completion + 404 + 503 disabled
  cases); OpenAI/Anthropic/DeepSeek paths are wired and typecheck clean but
  not yet hit with real keys (pending Jeffui providing them).
- `UpstreamEntry` gained `completions_path` (DeepSeek uses `/chat/completions`,
  not `/v1/chat/completions`) and `shared_rate_limit_key` (for NVIDIA's
  catalog-wide 20 RPM cap per CLAUDE.md, vs. the default per-model cap).

Upstreams added, pricing verified 2026-08-11 (two independent fetches each
against the provider's own pricing page — see `config.ts` comments):
- OpenAI: gpt-5.5 ($5/$30 per 1M), gpt-5.1 ($1.25/$10), gpt-5-mini ($0.25/$2)
- Anthropic: claude-opus-5 ($5/$25 per MTok), claude-sonnet-5 ($2/$10,
  introductory until 2026-08-31 then $3/$15), claude-haiku-4-5-20251001 ($1/$5)
- DeepSeek: deepseek-v4-flash ($0.14/$0.28 per 1M, cache-miss rate),
  deepseek-v4-pro ($0.435/$0.87 per 1M, cache-miss rate) — note DeepSeek
  also has cheaper cache-hit input pricing ($0.0028–$0.003625/1M) that
  isn't passed through since the router has no cache-awareness

**Not yet done**: NVIDIA beta-free entries are deliberately left empty in
`config.ts`. Chinese open-model IDs on NVIDIA's catalog (DeepSeek/Qwen/GLM
variants) change often and the only sources found were unverified
third-party blogs, not NVIDIA's own docs — plan is to call
`GET https://integrate.api.nvidia.com/v1/models` once `NVIDIA_API_KEY`
exists and pick real, current model IDs from that authoritative response
rather than hardcoding a guess.

## Daily pricing-check automation (2026-08-11)

Jeffui asked for daily price re-verification given Claude Sonnet 5's
introductory-pricing cliff on 2026-08-31. Looked at the `schedule` skill
(cloud routines) first — ruled out: cloud routines run in Anthropic's
cloud sandbox with no access to local files/services, and this project
isn't a git repo for one to clone anyway. Went with local automation
instead, consistent with everything else in this project living on the
Mac Studio:

- `scripts/pricing-check-prompt.txt` — self-contained prompt (must be,
  since a headless cron invocation has no conversation history)
- `scripts/check-pricing.sh` — runs `claude -p` with
  `--allowedTools "Read Edit WebFetch"` only (no Bash, no Write — it can
  only read config.ts/NOTES.md, edit them, and fetch pricing pages;
  structurally can't do anything destructive even unattended), logs to
  `logs/pricing-check.log`
- Installed via `crontab -e`: `0 9 * * *` (system tz is already KST, no
  UTC conversion needed) — runs daily at 9am
- Dry-run verified end-to-end before installing the cron entry: correctly
  cross-checked all 8 upstream entries, found no changes (same-day
  re-check), and correctly left `NOTES.md` untouched (job design: only
  logs to NOTES.md when a price actually changed, to keep it from
  accumulating daily no-op noise)

## Real keys wired in + a real streaming bug found and fixed (2026-08-11/12)

Jeffui provided ANTHROPIC_API_KEY, OPENAI_API_KEY, GROK_API_KEY,
GEMINI_API_KEY, NVIDIA_API_KEY, and later OPENROUTER_API_KEY, pasted
directly in chat. Written straight to `router/.env` (chmod 600, gitignored,
never echoed back). `router/src/index.ts` loads it via Node's native
`process.loadEnvFile()` (Node 20.12+/21.7+ built-in, no dotenv dependency
needed — we're on Node 25).

**Real streaming bug found via real keys** (would not have been caught by
typecheck or the local-model-only tests): `translateAnthropicStream` in
`router/src/providers/anthropic.ts` used a `pull()`-driven `ReadableStream`.
Anthropic's SSE stream opens with several events that carry no visible
text (`message_start`, `content_block_start` for the `thinking` block,
`ping`) — so the first couple of `pull()` calls read real bytes but had
nothing to `enqueue()`. Debug logging showed `pull()` called exactly twice
then never again, and curl hung until timeout with zero bytes received.
Root cause: relying on the runtime to keep re-invoking `pull()` after an
empty-enqueue return was not reliable under `@hono/node-server`'s
Response-streaming bridge. Fixed by driving the whole read loop from
`start()` instead (a manual `while(true)` over `reader.read()`) — the
standard robust pattern for wrapping one stream inside another, since it
doesn't depend on the pull-recall behavior at all. Verified fixed:
claude-sonnet-5 and claude-opus-5 both stream real content + a final
usage chunk + `[DONE]` correctly now.

**OpenAI param bug found and fixed**: gpt-5.5/gpt-5.1/gpt-5-mini reject
`max_tokens` ("Use 'max_completion_tokens' instead"). Added
`rename_max_tokens_to_completion` flag on `UpstreamEntry`, applied only to
those three entries — renames the field on the outbound request just
before forwarding to OpenAI, leaving every other upstream (which still use
`max_tokens`) untouched.

**Scope change**: dropped the NVIDIA-catalog plan for Chinese open models
(Jeffui: "그냥 오픈라우터 쓰자") in favor of OpenRouter, which is already
OpenAI-compatible with a public, authoritative `GET /api/v1/models`
pricing/context feed — no guessing at catalog model IDs the way NVIDIA
would have required. Added qwen/qwen3.7-max, moonshotai/kimi-k3,
z-ai/glm-5.2 this way, all pricing pulled live from that endpoint (not
scraped/summarized — parsed the JSON directly).

**Also added, beyond the original OpenAI/Anthropic-only ask**: Grok
(grok-4.5, grok-4.3 — pricing/context confirmed live via
`GET https://api.x.ai/v1/models`, their own raw token-price units
converted to USD: `usd_per_token = raw_unit * 1e-10`) and Gemini
(gemini-3.1-pro-preview, gemini-3.6-flash, gemini-3.5-flash-lite — context
lengths confirmed live via Gemini's own `models.list`; pricing from
ai.google.dev's pricing page). Both are OpenAI-compatible endpoints, no
translation layer needed (Gemini's is `https://generativelanguage.googleapis.com/v1beta/openai`).

**End-to-end verified with real keys** (all via `curl` against the running
router, not just typecheck): local, gpt-5-mini (non-stream + stream),
claude-sonnet-5 (stream), claude-opus-5 (stream), qwen3.7-max,
moonshotai/kimi-k3, z-ai/glm-5.2, grok-4.5 — all return real completions.
gemini-3.6-flash needed `max_tokens: 500` to get past its internal
thinking budget before it would emit visible content — same
reasoning-eats-the-budget behavior seen on gpt-oss-20b, GPT-5, and
Claude Sonnet 5. This is now a cross-provider pattern, not a
gpt-oss-20b quirk — strong, concrete evidence for CLAUDE.md's measurement
point #3 (streaming vs. prepay mismatch): a caller cannot know in advance
how much of a paid `max_tokens` budget a reasoning model will spend on
invisible thinking before producing any visible output.

**Not done**: DEEPSEEK_API_KEY was never provided, so `deepseek-v4-flash`
and `deepseek-v4-pro` remain correctly disabled (503) rather than broken.
NVIDIA_API_KEY exists but no NVIDIA entries were added (see the scope
change above) — the key is in `.env` unused for now.

**CLAUDE.md scope note, again**: the upstream table is now 6 providers /
17 models total, far past "1-2 paid upstreams." This was Jeffui's explicit,
repeated direction across this session, not a unilateral drift — flagging
again here since it's now a large enough gap from the original doc that
CLAUDE.md itself may be worth updating to match, rather than letting NOTES.md
be the only record of the real scope.

## NVIDIA beta-free catalog added (2026-08-12)

Jeffui: "nvidia가 제일 중요해 그거 추가해 공짜모델들" (NVIDIA is the most
important, add it, the free models). Pulled the live catalog via
`GET https://integrate.api.nvidia.com/v1/models` with the real key (not a
third-party listing this time — same lesson as the OpenRouter pull) and
hand-filtered ~100 entries down to 11 actual chat/instruct models, excluding
embedding/reranker/safety-guard/translation/parsing models that share the
same `/v1/models` listing but don't work against `/v1/chat/completions`:
meta/llama-3.3-70b-instruct, meta/llama-3.1-70b-instruct,
mistralai/mistral-large-2-instruct, nvidia/llama-3.1-nemotron-ultra-253b-v1,
nvidia/nemotron-3-super-120b-a12b, nvidia/nemotron-3-nano-30b-a3b,
deepseek-ai/deepseek-v4-flash-0731, z-ai/glm-5.2, moonshotai/kimi-k2.6,
minimaxai/minimax-m3, 01-ai/yi-large. All share one 20 RPM pool
(`shared_rate_limit_key: "nvidia-beta-free"`) per CLAUDE.md's self-imposed
cap, `cost: null` (free), `tier: "beta-free"`.

**Deliberately excluded**: `openai/gpt-oss-20b` is ALSO in this free
catalog (NVIDIA hosts it too), but it shares an id with `LOCAL_MODEL`.
Routing that id to NVIDIA would mean silently serving our own paid model's
requests off NVIDIA's free dev/eval tier instead of our own hardware —
likely a ToS violation (their free tier is explicitly not for serving
paying end users) and a direct contradiction of this project's whole
premise ("we run real inference on our own hardware"). Left out on
purpose; noted in a code comment in `config.ts` so it isn't "rediscovered"
and added by accident later.

**Operational finding**: cold-start latency on NVIDIA's free tier varies
enormously by model. `meta/llama-3.3-70b-instruct` took **73 seconds** for
a trivial "reply with pong" request (verified with a direct call to
NVIDIA, bypassing our router entirely — not a router bug), while
`nvidia/nemotron-3-nano-30b-a3b` responded near-instantly. This is a real
characteristic of the beta-free tier, not something to fix — worth
surfacing honestly if/when the API Hub listing gets a `status:
"experimental"` treatment in Phase 3, and worth keeping in mind that
`/models`' health/availability check doesn't currently probe latency, only
up/down.

**Two real bugs found while load-testing the free additions, both fixed**:
1. `z-ai/glm-5.2` was added with the *same id* to both the OpenRouter (paid)
   and NVIDIA (free) sections of `UPSTREAMS`. `Array.find` returns the
   first match, so the free entry was 100% unreachable — every request for
   it silently went to the paid OpenRouter path instead. Jeffui's framing
   for the fix: "유저가 프리 모델 사용을 명시하면 무조건 공짜 모델로 보내"
   (if the caller explicitly asks for the free model, always send it
   there). Fixed by adopting OpenRouter's own `:free` suffix convention —
   `z-ai/glm-5.2:free` is now a distinct, unambiguous table entry — plus a
   new `upstream_model_id` field on `UpstreamEntry` so the router can
   rewrite the outbound `model` field back to the upstream's real id
   (`z-ai/glm-5.2`, no suffix) before forwarding, since NVIDIA has never
   heard of the `:free` suffix and would 404 on it otherwise.
2. Empirically, 5 of the 11 NVIDIA "chat model" candidates picked from the
   catalog turned out to be non-functional on this account: `mistralai/
   mistral-large-2-instruct`, `nvidia/llama-3.1-nemotron-ultra-253b-v1`,
   `moonshotai/kimi-k2.6`, `01-ai/yi-large` all returned instant HTTP 404
   "Function ... Not found for account" (listed in `GET /v1/models` but not
   actually provisioned for this key); `deepseek-ai/deepseek-v4-flash-0731`
   hung with `UND_ERR_HEADERS_TIMEOUT` past 30s even called directly
   against NVIDIA. All 5 removed from `config.ts` — being *listed* in
   NVIDIA's `/v1/models` is not the same as being *callable*, and this
   needs re-checking (by actually calling each candidate, not just listing
   them) any time NVIDIA free entries are added in the future.

**Final verified-working NVIDIA beta-free set** (all tested with real
completions through the running router): `nvidia/nemotron-3-super-120b-a12b`
(~16s), `nvidia/nemotron-3-nano-30b-a3b` (fast), `minimaxai/minimax-m3`
(~36s), `meta/llama-3.1-70b-instruct` (~0.5s), `meta/llama-3.3-70b-instruct`
(~73s). `z-ai/glm-5.2:free` (the fix for the id-collision bug above) was
added, then pulled again minutes later: a direct call to NVIDIA for plain
`z-ai/glm-5.2` (bypassing our router) hung for **301 seconds** before
failing with `fetch failed`. GLM is only offered via the OpenRouter paid
entry now. The `upstream_model_id` field this fix introduced on
`UpstreamEntry` stays in the type either way — it's the right mechanism
for the next `:free`-alias collision, just not proven out on a working
example yet.

Final router state: **22 models across 7 upstream tiers** (local, OpenAI,
Anthropic, DeepSeek-direct-disabled, OpenRouter, Grok, Gemini,
NVIDIA-beta-free) — 1 local + 21 upstream entries, no duplicate ids,
typechecked and spot-checked live for every provider except DeepSeek
direct (no key provided).

## NVIDIA free set trimmed (2026-08-12)

Jeffui: "나머지 지원하는거 좀 오바임" (supporting the rest is overkill) —
cut `meta/llama-3.3-70b-instruct` (~73s), `meta/llama-3.1-70b-instruct`,
and `minimaxai/minimax-m3` (~36s) from the NVIDIA beta-free set. These
worked in testing (unlike the 5 removed earlier for being broken/hanging)
but were trimmed for being slow/unnecessary breadth, not for being broken
— noted as a distinct reason in `config.ts` so a future pass doesn't
re-add them thinking they were never tried. NVIDIA beta-free is now just
`nvidia/nemotron-3-super-120b-a12b` (~16s) and `nvidia/nemotron-3-nano-30b-a3b`
(fast). **Router total: 19 models** (down from 22).

## DeepSeek activated (2026-08-12)

Jeffui funded the DeepSeek account and provided `DEEPSEEK_API_KEY`, written
to `router/.env`. Both `deepseek-v4-flash` and `deepseek-v4-pro` verified
live — non-stream and stream both return real content ("pong") correctly
through the router's existing DeepSeek code path (the `/chat/completions`
path override and no other change was needed; that plumbing had been ready
and tested-shaped since it was first added, just waiting on a key).
**Router total: 19 models, all 19 now have a key configured** — every
upstream entry in `config.ts` is active, no more `status: "disabled"`
entries in `/models` due to a missing kill-switch env var.

## Project renamed to UniRouter; committed and pushed (2026-08-12)

First git history for this project. `git init` + first commit, then a
rename pass: `CLAUDE.md` title, `router/package.json` name, and a new
`README.md` (public-facing, structure loosely inspired by
github.com/BlockRunAI/ClawRouter but content kept honest to actual status
— no overclaiming x402 was live before it was). Repo:
https://github.com/snubeaver/unirouter (Jeffui renamed it lowercase after
I'd set the remote with mixed case; fixed via `git remote set-url`).

Jeffui explicitly asked for commits authored as themselves
(snubeaver/kwonij2@gmail.com), not with a Claude co-author line — set via
`git config --local`, not global.

README iteration, same day: split the model table into Free/Paid sections
sorted by price (Jeffui pointed out routing itself doesn't actually
distinguish free/paid at request time — it's model-id-only matching, the
split is purely informational, and the README now says so explicitly).
Also stripped all personal-machine framing ("Mac Studio," "my own
hardware," "apartment") per Jeffui: "우리는 라우터야. 내거에 대해서
중립적인 입장을 취해야해" (we're a router, need a neutral stance on what's
ours) — reworded to "our own compute" service-voice instead, and to lean
into the *cost* angle rather than the *ownership* angle per a follow-up
("provided cheap by our machine" style) — e.g. the architecture diagram
now reads "our own machine — the cheapest model in the table because of
it" rather than describing whose hardware it is.

## x402 payment gate shipped — Monad **mainnet**, not testnet (2026-08-12)

Jeffui: "이제 x402 띄우면 되나?" (can we spin up x402 now?), then decided
to skip testnet entirely: "바로 메인넷으로 갈거야" (going straight to
mainnet). This is a real deviation from CLAUDE.md's Phase 2 text ("USDC on
Monad testnet") and from CLAUDE.md's own "ask before spending real funds"
rule — flagged explicitly at the time, user confirmed mainnet intent
directly, and confirmed the receiving wallet address themselves
(`0x1995159c8d4df2268A17C0169a80f0e7d11a7424`, in `router/.env` as
`PAY_TO_ADDRESS`, not committed).

### What's real (verified live, not just typechecked)

- `POST /paid/chat/completions`: x402-gated via `@x402/hono` +
  `@x402/evm`'s `ExactEvmScheme`, flat `$0.0001` per request, network
  `eip155:143` (Monad mainnet). Called unauthenticated and got back a
  correct `402` with a `payment-required` header decoding to: asset
  `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` (USDC on Monad mainnet —
  cross-verified against Circle's own site, MonadScan, and Uniswap before
  trusting it, then found the *exact same address* already hardcoded
  inside `@x402/evm`'s source, which is about as confirmed as this gets
  without a chain explorer query), `payTo` matching the configured
  address, `amount: "100"` (100 raw units at USDC's 6 decimals = $0.0001,
  correct). No actual payment has been made yet — that requires a funded
  wallet and a signing client (the CLI, not started this session).
- Regression-checked: `/models` (still 19) and the existing free
  `/v1/chat/completions` path for the local model both still work
  unaffected by adding the new gated route.

### Real architectural finding: the middleware can't see the request body

`@x402/hono`'s `DynamicPrice` callback receives an `HTTPRequestContext`
with only `adapter` (exposing method/path/headers/URL), not the parsed
JSON body. Since our API takes `model` and `max_tokens` in the body (to
stay OpenAI-compatible), the payment layer structurally cannot price a
shared route by those fields without either a non-standard request shape
(e.g. duplicating them into query params for a price-lookup) or a
separate pre-flight quote step. This is a concrete, load-bearing piece of
evidence for CLAUDE.md's own thesis (item 3, streaming vs. prepay
mismatch) — not a library limitation to route around quietly.

**Decision** (Jeffui, given the tradeoff directly): ship flat per-request
pricing for v1, scoped to the local model only, exactly matching the
"proven" request-level settlement pattern CLAUDE.md already cites
(BlockRun, cost+5%). Per-token/dynamic pricing and other EVM chains are
explicitly future work, not solved here. `config.ts`'s `CHAINS` array
holds one entry (Monad mainnet) but is structured as a table specifically
so adding a second chain later is additive, not a rewrite of
`payment.ts`.

### CLI client shipped and published (2026-08-12, same day)

Jeffui provided their npm account (`snubeaver`), logged in via
`npm login --auth-type=web` (browser device flow, same pattern as the
earlier `gh auth login`).

Built `cli/` — a standalone package, `unirouter-cli`, not part of the
router's own package.json. Uses `@x402/fetch`'s
`wrapFetchWithPaymentFromConfig` + `@x402/evm`'s `ExactEvmScheme` to sign
and retry a 402 automatically from a wallet the caller controls (private
key from `WALLET_PRIVATE_KEY` env var, never accepted as a CLI argument —
avoids it landing in shell history). One command: `unirouter-cli chat
<message> [--url] [--max-tokens]`.

**Verified end-to-end, not just typechecked**: generated a throwaway
private key with zero balance, ran `unirouter-cli chat "say pong"` against
the live router. It correctly signed an EIP-3009
`transferWithAuthorization` payment, retried the request, and the
facilitator rejected it with `"error":"insufficient_funds"` — confirming
the *entire* protocol round-trip (challenge → sign → retry → facilitator
verify → clean rejection) works correctly on Monad mainnet. The only
missing piece for an actual successful paid response is a wallet with
real USDC + real MON for gas — no funds have been moved, this was
deliberately tested with an empty wallet.

**Publishing hit real npm account-security friction, not code issues**:
1. First `npm publish` attempt: `403 ... Two-factor authentication or
   granular access token with bypass 2fa enabled is required`. Jeffui's
   npm account had no 2FA configured.
2. Jeffui enabled 2FA — but as a phone passkey (WebAuthn/platform
   authenticator), not a TOTP app. `npm publish --otp=<code>` has no code
   to give it in that setup; passkey 2FA doesn't produce a numeric OTP.
3. Resolved via a **granular access token** (npmjs.com → Settings →
   Access Tokens → Granular Access Token, "Bypass two-factor
   authentication for write requests" enabled) — set via
   `npm config set //registry.npmjs.org/:_authToken <token>`. This is the
   documented way to let CI/automation (or a passkey-only account) publish
   without an interactive OTP prompt.

Published `unirouter-cli@0.1.0`, then found and fixed a small argument
-parsing bug (`unirouter-cli --help` as the very first, unaccompanied
argument didn't match the help-detection branch — worked fine as
`unirouter-cli chat --help` or bare `unirouter-cli help`, just not
`--help` alone) and republished as `0.1.1`. Confirmed via `npm install` in
a scratch directory that the published tarball's bin symlink, shebang,
and file permissions all survived intact.

### First real settled payment — and a real upstream bug found (2026-08-12)

Jeffui: fund a fresh agent wallet, test it against the local router, tell
them how much is needed. Generated a new wallet
(`0x0A1Fd8Fd01db4eC5a4982Ab9bbD26a09bec87E45`, key in `cli/.env`,
gitignored) and reported back: only USDC needed, no MON — the facilitator
covers settlement gas from its own relayer, confirmed later on-chain (see
below). Suggested $1 USDC as a round, low-risk test amount ($0.0001/req ×
10,000 requests). Jeffui sent it; confirmed arrival via a direct
`eth_call` to `balanceOf` before attempting anything (no reason to trust
a "sent" claim over checking the chain directly).

First real attempt failed with `"error":"unexpected_error"` — different
from the earlier `insufficient_funds` result, so genuinely new territory.
Root-caused it as a real bug in `@x402/evm@2.21.0`: their hardcoded
per-network token metadata declares Monad mainnet USDC's EIP-712 domain
name as `"USD Coin"`. Verified via direct `eth_call`s to the deployed
contract (`name()`, `version()`, `DOMAIN_SEPARATOR()`) that it's actually
`"USDC"`. The x402 client (`ExactEvmScheme`) builds its signing domain
from whatever `extra.name`/`extra.version` the *server* declares in the
402 challenge (grepped the client bundle to confirm: `name:
extra.name`) — so as long as our server declares the right name, the
client automatically signs correctly, no client-side patch needed.

**Fix**: `router/src/payment.ts` now calls
`ExactEvmScheme().registerMoneyParser(...)`, overriding the declared
`extra` for `eip155:143` to `{name: "USDC", version: "2"}` while keeping
the correct asset address and amount conversion. No `node_modules`
patching — this is a first-class extension point the library already
exposes for exactly this kind of per-network override.

**Verified for real, not just protocol-shape**: `unirouter-cli chat`
against the live router with the funded wallet returned `HTTP 200` with
actual local-model inference output and a `payment-response` header
decoding to a real transaction hash
(`0x8e2a5ca37f84d2ed8bde7119676175d9b78bbc57c33d2d530490bec336ae9d18`).
Independently confirmed via `eth_getTransactionReceipt` (not just trusting
the facilitator's claim): `status: success`, a `Transfer` event moving
exactly 100 raw units ($0.0001) from the test wallet to `PAY_TO_ADDRESS`,
`from` on the tx itself was the facilitator's relayer address (gas paid by
them, not the payer, exactly as documented). Re-checked the wallet's
on-chain balance after: `$0.9999`, down from `$1.0000` — matches to the
cent. This is a fully closed loop: agent wallet → x402 challenge → signed
authorization → facilitator-relayed settlement → real inference response,
on Monad mainnet, with real USDC.

Worth reporting upstream (not done yet, flagging as a possible next
step): `x402-foundation/x402`'s Monad mainnet token metadata is wrong and
would silently break any other integrator's first real payment the same
way it broke ours.

### Not done yet

- Reporting the `@x402/evm` domain-name bug upstream (GitHub issue) — not
  done, would help other Monad integrators hit the same wall faster.
- Other EVM chains beyond Monad — `CHAINS` table in `config.ts` is ready
  for it, no second entry added.
- Per-token/dynamic pricing — blocked on the same body-visibility
  constraint noted above; no workaround attempted yet.

## Revenue leak found and fixed: every paid upstream was free to call (2026-08-12)

Jeffui, after asking whether Claude payment had been tested and learning
it hadn't (the paid route only ever covered the local model): "뭐하는
짓이야. 다른 모델들을 그럼 내가 공짜로 애들한테 제공하고 있다고?
당연히 먼저 402로 내가 돈 받고 인퍼런스 해줘야지" (what are you doing —
so I'm giving the other models away for free? Obviously I should get paid
via 402 before doing inference). Correct and overdue: `/v1/chat/completions`
had been open, unauthenticated, and serving *every* model including every
paid upstream (Claude, GPT-5, Grok, Gemini, DeepSeek, OpenRouter) this
entire session — real API credits spent with zero compensation, the exact
opposite of the project's premise.

**Fix, same session**:
- Added `toSlug()` (model id with `/` → `-`, since ids like
  `qwen/qwen3.7-max` can't be a raw URL path segment) and
  `prepayMaxPriceUsd()` (assume `PREPAY_ASSUMED_PROMPT_TOKENS` (500) +
  `PREPAY_ASSUMED_COMPLETION_TOKENS` (1000), charge for that) to
  `config.ts`.
- `payment.ts` now builds one x402-gated route per payable model —
  `POST /paid/<slug>/chat/completions` — generated from `LOCAL_MODEL` +
  every `tier: "paid"` upstream, each with its own static price (no
  `DynamicPrice`/path-parsing needed since prices are known at startup).
- `index.ts`: `/v1/chat/completions` now checks `PAYABLE_MODELS` first —
  any payable model (local or paid upstream) gets a `402` pointing at the
  correct `/paid/<slug>` endpoint instead of being served. Only
  `beta-free` models (the two NVIDIA ones) still work on the open route,
  since there's no real cost to protect there.
- Refactored the upstream-dispatch logic (rate-limit check, kill-switch
  check, openai-compatible vs. anthropic-native branching) out of the old
  single handler into `proxyToUpstream()`, shared by both the free
  (beta-free-only) and paid routes — avoided duplicating that logic
  across two call sites.
- `/models` gained a `payment` field per model (`endpoint` + `price_usd`)
  so a caller can discover the right route instead of guessing the slug
  format.
- `unirouter-cli`: added `--model <slug>` (defaults to
  `openai-gpt-oss-20b`) so it can target any payable model, not just
  local. Published as `0.1.3`, then `0.1.4` for a docs-only README fix.

**Verified for real — paid for Claude specifically, since that's the
model that triggered this**: `unirouter-cli chat "..." --model
claude-haiku-4-5-20251001` against the live router. Got a real "pong" and
a settled transaction
(`0xc02026ba25aaf81ab9a17e01b702a8cae55a826aef79475905e8ec72845cbef4`).
Confirmed independently via `eth_getTransactionReceipt`: `status:
success`, a `Transfer` event for exactly 5500 raw units ($0.0055) —
matches `prepayMaxPriceUsd` for Claude Haiku's cost
(`0.000001×500 + 0.000005×1000 = 0.0055`) exactly. Also re-verified the
Monad USDC domain-name fix from the earlier local-only test still applies
here (same `monadUsdcScheme` money-parser override, now shared across all
payable models via one `x402ResourceServer` registration).

Regression-checked: `nvidia/nemotron-3-nano-30b-a3b` still works
unauthenticated on `/v1/chat/completions` (200), `gpt-5-mini` on the same
route now correctly 402s instead of running for free, `/models` still
reports all 19 entries.
