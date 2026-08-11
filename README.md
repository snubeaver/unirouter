# UniRouter

**Becoming an inference provider requires a wallet, not a company.**

UniRouter is a personal, from-scratch inference router: one OpenAI-compatible
endpoint in front of a GPU I own (running [vLLM](https://github.com/vllm-project/vllm)
on Apple Silicon Metal) and 7 upstream API tiers, with per-request pricing
and (in progress) [x402](https://github.com/x402-foundation/x402) payments
so an autonomous agent can pay for inference with a wallet — no signup, no
invoicing, no company required.

> **Status: experimental.** This is a solo project, not a Monad Foundation
> product. Uptime is "one Mac Studio in someone's apartment." Read that as
> the honest baseline it is, not a hedge.

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![vLLM](https://img.shields.io/badge/vLLM-Metal-8A2BE2)](https://github.com/vllm-project/vllm)
[![x402](https://img.shields.io/badge/x402-in%20progress-orange)](https://github.com/x402-foundation/x402)
[![status](https://img.shields.io/badge/status-experimental-yellow)]()

---

## Why this exists

OpenRouter-style aggregators are the incumbent model for "one endpoint, many
models." But *becoming* a provider on them requires a legal entity, monthly
invoicing, an application process, and sustained traffic. UniRouter is the
other side of that argument: an individual with a GPU and a wallet address
can list an endpoint, set a price, and get paid per request — today, on
testnet, with real inference behind it.

The router itself is deliberately dumb — no LiteLLM, no framework, one
~90-line request handler (`router/src/index.ts`) that matches a model id
against a table and proxies. The interesting part isn't the routing logic;
it's that the whole stack (compute, pricing, and eventually settlement)
fits on one machine and one config file.

## Architecture

```
Agent (pays via x402)
   │
   ▼
UniRouter — TS + Hono, one process, port 3402
   │
   ├── localhost:8000 ── vLLM Metal serving gpt-oss-20b (my own hardware)
   ├── OpenAI, Anthropic, DeepSeek, Grok, Gemini ── direct, paid
   ├── OpenRouter ── Qwen / Kimi / GLM
   └── NVIDIA build.nvidia.com ── beta-free tier (rate-capped, killable)
```

- The router never loads a model. All real compute is the local vLLM
  process or someone else's API.
- Every upstream carries a `tier`, a `kill_switch` env var (pull a route in
  under 5 minutes with zero deploys), and a rate limit.
- `fee_bps` — the markup UniRouter adds on top of pass-through cost — is a
  single config constant, currently `0`.

## Supported models

19 models, live-checked against every provider's own API — not scraped,
not guessed. `GET /models` reflects real-time availability (a live health
check for the local model; a kill-switch check for everything else).

| Model | Tier | Context | Price ($/1M tok, in / out) |
|---|---|---|---|
| `openai/gpt-oss-20b` | local (own hardware) | 32K | $0.03 / $0.13 |
| `gpt-5.5` | OpenAI | 1.05M | $5.00 / $30.00 |
| `gpt-5.1` | OpenAI | 400K | $1.25 / $10.00 |
| `gpt-5-mini` | OpenAI | 400K | $0.25 / $2.00 |
| `claude-opus-5` | Anthropic | 1M | $5.00 / $25.00 |
| `claude-sonnet-5` | Anthropic | 1M | $2.00 / $10.00 |
| `claude-haiku-4-5` | Anthropic | 200K | $1.00 / $5.00 |
| `deepseek-v4-flash` | DeepSeek | 1M | $0.14 / $0.28 |
| `deepseek-v4-pro` | DeepSeek | 1M | $0.43 / $0.87 |
| `qwen/qwen3.7-max` | OpenRouter | 1M | $1.48 / $4.42 |
| `moonshotai/kimi-k3` | OpenRouter | 1.05M | $3.00 / $15.00 |
| `z-ai/glm-5.2` | OpenRouter | 1.05M | $0.49 / $1.54 |
| `grok-4.5` | xAI | 500K | $2.00 / $6.00 |
| `grok-4.3` | xAI | 1M | $1.25 / $2.50 |
| `gemini-3.1-pro-preview` | Google | 1.05M | $2.00 / $12.00 |
| `gemini-3.6-flash` | Google | 1.05M | $1.50 / $7.50 |
| `gemini-3.5-flash-lite` | Google | 1.05M | $0.30 / $2.50 |
| `nvidia/nemotron-3-super-120b-a12b` | NVIDIA beta-free | 128K | Free |
| `nvidia/nemotron-3-nano-30b-a3b` | NVIDIA beta-free | 128K | Free |

Pricing on every non-local model is the provider's real cost, pass-through
(`fee_bps` markup on top, currently `0`). Local pricing is a hybrid
floor-plus-per-token schedule pegged to the OpenRouter market median for
gpt-oss-20b — never invented, and re-verified daily (see below).

## Quick start

```bash
cd router
npm install
cp .env.example .env   # fill in the keys for whichever upstreams you want live
npm run start          # router on http://localhost:3402
```

```bash
curl http://localhost:3402/models

curl http://localhost:3402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "openai/gpt-oss-20b", "messages": [{"role":"user","content":"hi"}], "stream": true}'
```

Any upstream without its API key set in `.env` shows up as
`"status": "disabled"` in `/models` and 503s cleanly if called — nothing
silently falls back to a different, possibly-paid model.

## What's real vs. what's next

| Phase | Status |
|---|---|
| **Serve** — vLLM Metal + gpt-oss-20b, OpenAI-compatible, streaming + usage tokens | ✅ done |
| **Route** — one endpoint, 19 models, 8 upstream tiers, live health/rate-limit gating | ✅ done |
| **Pay** — x402 middleware, USDC on Monad testnet, wallet-native client | 🚧 in progress |
| **List** — feed.json entry on the Monad API Hub | ⬜ not started |

The payment layer is the actual point of this project — everything above
is the substrate it needs to exist on top of. Measurements on serving
latency, streaming-vs-prepay economics, and per-request settlement cost
are being tracked as they come in.

## Keeping it honest

- A cron job re-verifies every paid upstream's pricing daily against the
  provider's own pricing page and patches `config.ts` if anything changed
  (e.g. Claude Sonnet 5's introductory pricing steps up on 2026-08-31).
- Every model in the table above was called for a real completion before
  being added — several NVIDIA "free" models that looked fine in their
  catalog listing turned out to be unprovisioned or hung for minutes on
  real calls, and were cut rather than shipped hoping they'd work.
- No upstream is silently substituted for another. If a route is down or
  disabled, the caller gets a clear error, not a surprise model or a
  surprise bill.

## Non-goals

- Not a Monad-branded product — an independent project that happens to
  settle on Monad.
- Not trying to out-router OpenRouter on model breadth. The point is the
  wallet-not-a-company argument, not the catalog size.
- No LiteLLM, no provider SDK abstraction layer. The routing table is
  meant to stay readable in one sitting.
