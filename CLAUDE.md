# UniRouter — Inference Provider + x402 Router

Personal project (not a Monad Foundation project). Goal: run a real inference
provider on my own hardware, wrap it in an x402 payment layer and a mini
router, list it on the Monad API Hub, and document the whole journey as
(1) a public blog post and (2) an internal one-pager arguing for an
inference exchange on Monad.

The demo must prove one sentence: **"Becoming an inference provider requires
a wallet, not a company."** (Contrast: OpenRouter providers need a legal
entity, monthly invoicing, an application process, and sustained traffic.)

## Hardware / environment

- Mac Studio M2 Max — 12-core CPU, 30-core GPU, 32GB unified memory, 512GB SSD
- Memory bandwidth 400GB/s; GPU-usable memory ~24GB by default (don't touch
  `iogpu.wired_limit_mb` unless we hit a wall)
- macOS, accessed via SSH from a MacBook; long-running work lives in tmux
  session `inference` (window 1: claude, window 2: vllm, window 3: bench)
- 512GB SSD is small: keep exactly ONE model on disk (gpt-oss-20b). Do not
  download comparison models without asking.

## Architecture (3 layers, keep them separate)

```
Agent (pays via x402; client = `mon` CLI from @monad/pay)
   |
Router  — thin TS/Hono web service, NO models, port 3402
   |-- localhost:8000  vLLM Metal serving gpt-oss-20b (the only real compute)
   |-- NVIDIA build.nvidia.com catalog (beta-free tier, see constraints)
   |-- 1-2 paid upstreams (DeepSeek direct or OpenRouter credits)
   |
Listing — feed.json entry for Monad API Hub (JSON Feed 1.1 + _monad namespace)
```

- vLLM is a serving engine, not a router. The router never loads models.
- Router stack: TypeScript + Hono, runs as a plain Node process on the
  Studio (NOT Cloudflare Workers — it must reach localhost:8000).
- Routing logic v1 is deliberately dumb: match model name -> local if
  gpt-oss-20b, else upstream by table; health-check local, fall back to
  upstream if down. ~50 lines. Do NOT pull in LiteLLM or any prebuilt
  proxy — hand-rolled routing is the point of the writeup.

## Phases

1. **Serve**: vLLM Metal + gpt-oss-20b behind an OpenAI-compatible API
   (streaming + usage tokens required). Add a `/models` endpoint modeled on
   OpenRouter's provider spec: pricing, context length, metadata.
2. **Pay**: x402 payment middleware in front of the router. USDC on Monad
   testnet. Client-side payments via `mon` CLI (dogfooding @monad/pay).
3. **Loop**: an agent discovers the endpoint via API Hub feed.json, pays via
   x402, receives inference. Record a ~30s screen capture of the full loop —
   this is the killer demo asset.

## Pricing & fees

- Local gpt-oss-20b: hybrid **per-request floor + per-token** —
  $0.0001 minimum per request, then $0.03 / $0.13 per 1M input/output tokens
  (pegged to the OpenRouter market median for this model; do not invent prices).
- Paid upstreams: cost pass-through + `fee_bps` markup.
- `fee_bps` is a config parameter, currently **0**. Never hardcode the fee.
- Rationale (for the writeup): request-level x402 settlement is proven
  (BlockRun charges cost+5%); the open problem is token/chunk-level
  settlement for streaming — that gap is the argument for an exchange.

## Upstream constraints (IMPORTANT — encode in config, not just docs)

Every upstream entry carries:
- `tier`: `"local" | "beta-free" | "paid"`
- `kill_switch`: env var that removes the route with zero deploys
- `rate_limit`: router-side RPM cap

NVIDIA build.nvidia.com free catalog:
- Allowed ONLY while this is a dev/beta project (their ToS permits
  development/testing/evaluation; production = serving real end users).
- `tier: "beta-free"`, killable via env var in <5 min. If killed, the local
  gpt-oss-20b inherits the free tier (our structural advantage: we have our
  own compute as a backstop).
- Self-imposed cap: 20 RPM total + per-wallet limit (their key-wide limit is
  ~40 RPM; never let one abuser burn the key).
- Never mention NVIDIA free models in the API Hub listing metadata or in any
  headline/marketing copy. The listing describes only our endpoint + pricing.
- When third parties start paying real money at scale, this route must be
  OFF unless we have written clearance from NVIDIA.

## API Hub listing (Phase 3)

- feed.json entry, JSON Feed 1.1 with `_monad` namespace: price fields,
  x402 payment address, model metadata, context length, and a
  `status: "experimental"` tag (uptime is one consumer machine; be honest).
- No Monad branding on the router itself — it's an independent third-party
  project that settles on Monad.

## Measurements to capture (these feed the blog post + one-pager)

1. Serving: single-stream tok/s, TTFT, and behavior under 2-4 concurrent
   requests (expect batch weakness vs CUDA — record it honestly).
2. Payment: x402 overhead added to TTFT (expected ~200-500ms class);
   settlement tx cost per request on Monad testnet.
3. Streaming vs prepay mismatch: document concretely how "pay before you
   know output length" breaks — prepay-max vs trust-based postpay vs
   chunk settlement. This is the core evidence for per-chunk fills.
4. Unit economics: revenue/hr at listed price vs power cost
   (M2 Max under load ~90W).

## Conventions

- Keep secrets in `.env` (gitignored): wallet keys, NVIDIA API key, upstream
  keys. Never commit them.
- vLLM runs in a tmux window, NOT as a launchd service, until the demo is
  stable (fast log-read/debug loop matters more than uptime for now).
- Ask before: downloading models, changing system settings (sysctl, sshd),
  or anything spending real (non-test) funds.
- Blog post is written separately by me; your job is code, benchmarks, and
  keeping NOTES.md updated with measurements and decisions as we go.
