# UniRouter

**An inference router for anyone who can pay via x402.**

UniRouter is an OpenAI-compatible inference router: one endpoint in front of
a local [vLLM](https://github.com/vllm-project/vllm) backend and seven
upstream providers, priced per request and paid for via
[x402](https://github.com/x402-foundation/x402) on Monad mainnet.

> **Status: experimental.** Not a Monad Foundation product.

**Live endpoint:** `https://geralyn-phototelegraphic-greta.ngrok-free.dev`

[![npm](https://img.shields.io/npm/v/unirouter-cli.svg?logo=npm)](https://www.npmjs.com/package/unirouter-cli)
[![npm downloads](https://img.shields.io/npm/dm/unirouter-cli.svg)](https://www.npmjs.com/package/unirouter-cli)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![vLLM](https://img.shields.io/badge/vLLM-Metal-8A2BE2)](https://github.com/vllm-project/vllm)
[![x402](https://img.shields.io/badge/x402-Monad%20mainnet-brightgreen)](https://github.com/x402-foundation/x402)
[![status](https://img.shields.io/badge/status-experimental-yellow)]()

---

## Architecture

```
Agent (pays via x402)
   │
   ▼
UniRouter — TS + Hono, one process, port 3402
   │
   ├── localhost:8000 ── vLLM serving openai/gpt-oss-20b
   ├── OpenAI, Anthropic, DeepSeek, Grok, Gemini ── direct, paid
   ├── OpenRouter ── Qwen / Kimi / GLM
   └── NVIDIA build.nvidia.com ── beta-free tier (rate-capped, killable)
```

- The router does not run any model itself. Requests are proxied to the
  local vLLM process or to an upstream provider's API.
- Every upstream has a `tier`, a `kill_switch` env var, and a rate limit.
- `fee_bps` (markup on pass-through cost, currently `0`) is a single
  config constant in `router/src/config.ts`.

## Models

`GET /models` lists every model with live availability and, for paid
models, the exact payment endpoint and price.

Two models are free (NVIDIA's beta-free tier — no cost to protect).
Every other model, including the local one, requires payment; calling it
on the free endpoint returns `402` with the correct paid route.

### Free — `POST /v1/chat/completions`

| Model | Provider | Context |
|---|---|---|
| `nvidia/nemotron-3-nano-30b-a3b` | NVIDIA beta-free | 128K |
| `nvidia/nemotron-3-super-120b-a12b` | NVIDIA beta-free | 128K |

### Paid — `POST /paid/<slug>/chat/completions`

Sorted by input price ($/1M tokens):

| Model | Provider | Context | Price (in / out) |
|---|---|---|---|
| `openai/gpt-oss-20b` | local | 32K | $0.03 / $0.13 |
| `deepseek-v4-flash` | DeepSeek | 1M | $0.14 / $0.28 |
| `gpt-5-mini` | OpenAI | 400K | $0.25 / $2.00 |
| `gemini-3.5-flash-lite` | Google | 1.05M | $0.30 / $2.50 |
| `deepseek-v4-pro` | DeepSeek | 1M | $0.43 / $0.87 |
| `z-ai/glm-5.2` | OpenRouter | 1.05M | $0.49 / $1.54 |
| `claude-haiku-4-5` | Anthropic | 200K | $1.00 / $5.00 |
| `gpt-5.1` | OpenAI | 400K | $1.25 / $10.00 |
| `grok-4.3` | xAI | 1M | $1.25 / $2.50 |
| `qwen/qwen3.7-max` | OpenRouter | 1M | $1.48 / $4.42 |
| `gemini-3.6-flash` | Google | 1.05M | $1.50 / $7.50 |
| `claude-sonnet-5` | Anthropic | 1M | $2.00 / $10.00 |
| `grok-4.5` | xAI | 500K | $2.00 / $6.00 |
| `gemini-3.1-pro-preview` | Google | 1.05M | $2.00 / $12.00 |
| `moonshotai/kimi-k3` | OpenRouter | 1.05M | $3.00 / $15.00 |
| `gpt-5.5` | OpenAI | 1.05M | $5.00 / $30.00 |
| `claude-opus-5` | Anthropic | 1M | $5.00 / $25.00 |

These per-token rates are the provider's real cost, pass-through plus
`fee_bps`. What a request actually charges is a flat, prepay-max amount —
see [Pricing](#pricing) below, prices are also available per model via
`GET /models`.

## Quick start

```bash
cd router
npm install
cp .env.example .env   # add the keys for whichever upstreams you want live
npm run start          # http://localhost:3402
```

```bash
curl http://localhost:3402/models

curl http://localhost:3402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "nvidia/nemotron-3-nano-30b-a3b", "messages": [{"role":"user","content":"hi"}], "stream": true}'
```

An upstream without its API key set in `.env` reports
`"status": "disabled"` on `/models` and returns `503` if called directly.

## Paying for inference

Every paid model has its own route: `POST /paid/<slug>/chat/completions`,
where `<slug>` is the model id with `/` replaced by `-`
(`qwen/qwen3.7-max` → `qwen-qwen3.7-max`). `GET /models` reports the exact
slug and price for each model.

```bash
curl -i http://localhost:3402/paid/gpt-5-mini/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role":"user","content":"hi"}], "max_tokens": 20}'
# → 402, with a `payment-required` header carrying price/asset/payTo.
#   Attach a signed payment and retry to get served.
```

[`unirouter-cli`](https://www.npmjs.com/package/unirouter-cli) (`cli/` in
this repo) signs and retries the 402 from your wallet:

```bash
npm install -g unirouter-cli
export WALLET_PRIVATE_KEY=0x...   # USDC on Monad mainnet; no MON needed —
                                   # the facilitator covers settlement gas
unirouter-cli chat "hello" --model gpt-5-mini   # defaults to the live endpoint above
```

Settlement is on Monad mainnet (`eip155:143`) via `@x402/evm`; `payTo` is
the operator's wallet, `asset` is USDC.

## Pricing

The local model charges a flat $0.0001 per request. Every other paid
model charges a flat **prepay-max** estimate — 500 prompt tokens + 1000
completion tokens at that model's real rate, charged upfront regardless
of actual usage — since price is set before the request body is
available to the payment layer.

## Roadmap

| Phase | Status |
|---|---|
| Serve — vLLM + gpt-oss-20b, OpenAI-compatible, streaming | done |
| Route — 19 models, 8 upstream tiers, health/rate-limit gating | done |
| Pay — x402 on Monad mainnet, per-model gating, CLI client | done |
| Pay — per-token pricing, additional EVM chains | in progress |
| List — feed.json entry on the Monad API Hub | not started |
