# UniRouter

**Becoming an inference provider requires a wallet, not a company.**

UniRouter is a from-scratch inference router: one OpenAI-compatible endpoint
in front of our own [vLLM](https://github.com/vllm-project/vllm) compute —
kept cheap because it's ours, no margin stacked on top — plus 7 upstream API
tiers, with per-request pricing and [x402](https://github.com/x402-foundation/x402)
payments so an autonomous agent can pay for inference with a wallet — no
signup, no invoicing, no company required.

> **Status: experimental.** Not a Monad Foundation product. Read
> "experimental" as the honest baseline it is, not a hedge.

[![npm](https://img.shields.io/npm/v/unirouter-cli.svg?logo=npm)](https://www.npmjs.com/package/unirouter-cli)
[![npm downloads](https://img.shields.io/npm/dm/unirouter-cli.svg)](https://www.npmjs.com/package/unirouter-cli)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![vLLM](https://img.shields.io/badge/vLLM-Metal-8A2BE2)](https://github.com/vllm-project/vllm)
[![x402](https://img.shields.io/badge/x402-Monad%20mainnet-brightgreen)](https://github.com/x402-foundation/x402)
[![status](https://img.shields.io/badge/status-experimental-yellow)]()

---

## Why this exists

OpenRouter-style aggregators are the incumbent model for "one endpoint, many
models." But *becoming* a provider on them requires a legal entity, monthly
invoicing, an application process, and sustained traffic. UniRouter is the
other side of that argument: anyone with compute and a wallet address can
list an endpoint, set a price, and get paid per request — no intermediary
account, no approval process.

The router itself is deliberately dumb — no LiteLLM, no framework, one
~90-line request handler (`router/src/index.ts`) that matches a model id
against a table and proxies. The interesting part isn't the routing logic;
it's that the whole stack (compute, pricing, and settlement) fits in one
config file, regardless of who's operating it or what's behind the local
endpoint.

## Architecture

```
Agent (pays via x402)
   │
   ▼
UniRouter — TS + Hono, one process, port 3402
   │
   ├── localhost:8000 ── vLLM serving gpt-oss-20b (our own machine — the cheapest model in the table because of it)
   ├── OpenAI, Anthropic, DeepSeek, Grok, Gemini ── direct, paid
   ├── OpenRouter ── Qwen / Kimi / GLM
   └── NVIDIA build.nvidia.com ── beta-free tier (rate-capped, killable)
```

- The router never loads a model itself. All real compute is the local
  vLLM process or an upstream provider's API.
- Every upstream carries a `tier`, a `kill_switch` env var (pull a route in
  under 5 minutes with zero deploys), and a rate limit.
- `fee_bps` — the markup UniRouter adds on top of pass-through cost — is a
  single config constant, currently `0`.

## Supported models

19 models, live-checked against every provider's own API — not scraped,
not guessed. `GET /models` reflects real-time availability (a live health
check for the local model; a kill-switch check for everything else) and
now also includes a `payment` field per model with the exact endpoint and
price to use.

Only the two `beta-free` models below are reachable on the open
`POST /v1/chat/completions` — there's no real cost to protect on those.
Every other model (local hardware included) is payment-gated on its own
`POST /paid/<slug>/chat/completions` route; hitting it on the free route
now returns a `402` pointing at the correct paid endpoint instead of
silently running for free. This wasn't always true — see "Paying for
inference" below for the incident that forced it.

### Free

| Model | Provider | Context |
|---|---|---|
| `nvidia/nemotron-3-nano-30b-a3b` | NVIDIA beta-free | 128K |
| `nvidia/nemotron-3-super-120b-a12b` | NVIDIA beta-free | 128K |

### Paid — sorted by input price ($/1M tokens)

| Model | Provider | Context | Price (in / out) |
|---|---|---|---|
| `openai/gpt-oss-20b` | our own machine | 32K | $0.03 / $0.13 |
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

Per-token prices above are the provider's real cost, pass-through
(`fee_bps` markup on top, currently `0`), and are what `/models` reports —
but what a `/paid` request actually charges is a flat **prepay-max**
estimate per model (see "Why flat-rate" below), not these per-token rates
directly. Local pricing is a hybrid floor-plus-per-token schedule pegged
to the OpenRouter market median for gpt-oss-20b — never invented, and
re-verified daily (see below).

## Quick start

```bash
cd router
npm install
cp .env.example .env   # fill in the keys for whichever upstreams you want live
npm run start          # router on http://localhost:3402
```

```bash
curl http://localhost:3402/models

# the only models callable for free — everything else needs payment, see below
curl http://localhost:3402/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "nvidia/nemotron-3-nano-30b-a3b", "messages": [{"role":"user","content":"hi"}], "stream": true}'
```

Any upstream without its API key set in `.env` shows up as
`"status": "disabled"` in `/models` and 503s cleanly if called — nothing
silently falls back to a different, possibly-paid model.

## Paying for inference

Every model except the two `beta-free` ones has its own payment-gated
route: `POST /paid/<slug>/chat/completions`, where `<slug>` is the model
id with `/` replaced by `-` (e.g. `qwen/qwen3.7-max` → `qwen-qwen3.7-max`;
`GET /models` reports the exact slug and price for every model, no need to
compute it by hand). Charged via [x402](https://github.com/x402-foundation/x402)
on Monad mainnet:

```bash
curl -i http://localhost:3402/paid/gpt-5-mini/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role":"user","content":"hi"}], "max_tokens": 20}'
# → HTTP 402, a `payment-required` header with the exact price/asset/payTo,
#   settled on retry once a caller attaches a signed payment.
```

This wasn't the original design: `/paid/chat/completions` used to be a
single route that only gated the local model, while
`POST /v1/chat/completions` served every other model — including every
paid upstream — for free. That meant real OpenAI/Anthropic/etc. API
credits were being spent on unauthenticated traffic. Fixed by giving
every paid model its own gated route and closing the free route down to
`beta-free` models only.

The easiest way to actually pay: [`unirouter-cli`](https://www.npmjs.com/package/unirouter-cli)
(`cli/` in this repo) — signs and retries the 402 automatically from a
wallet you hold:

```bash
npm install -g unirouter-cli
export WALLET_PRIVATE_KEY=0x...   # needs real USDC on Monad mainnet (no MON —
                                   # the facilitator pays settlement gas, not you)
unirouter-cli chat "hello" --url http://localhost:3402 --model gpt-5-mini
```

**Verified with real settled payments, not just a protocol-shape check**:
paid $0.0001 for the local model and $0.0055 for `claude-haiku-4-5` in
separate runs, both got back real inference output and a transaction
hash. Independently confirmed on-chain via `eth_getTransactionReceipt`
for both — genuine `Transfer` events for the exact charged amount, gas
paid by the facilitator's relayer, not the payer. This surfaced (and we
fixed) a real bug along the way: `@x402/evm`'s hardcoded Monad USDC
metadata has the wrong EIP-712 domain name (`"USD Coin"` vs. the deployed
contract's actual `"USDC"`), which silently breaks every signature until
corrected — worked around server-side via a custom money parser, no fork
needed. See `NOTES.md` for the full trace on both incidents.

`network: "eip155:143"` (Monad mainnet), `asset` is USDC's real mainnet
contract address, `payTo` is the operator's own wallet — all pulled from
`@x402/evm`'s built-in Monad support and `router/src/config.ts`, nothing
hardcoded by hand. Pricing is deliberately flat per model, not per-token:
see "Why flat-rate" below.

### Why flat-rate, not per-token

The obvious "correct" design would price each request by its actual
token usage. It doesn't work cleanly here: the x402 middleware decides the
price *before* the request body is parsed (it only has access to the
method/path/headers), so a route can't price itself dynamically off
`model` or `max_tokens` without either a second network round-trip or a
non-standard request shape. Request-level flat pricing is also the
*proven* pattern in production x402 usage today (e.g. BlockRun settles at
cost+5% per request); token/chunk-level settlement is the open problem.
Flat-rate here isn't a shortcut — it's the accurate reflection of where
the ecosystem actually is.

For paid upstream models specifically, the flat price is a **prepay-max**
estimate: assume every request uses 500 prompt tokens + 1000 completion
tokens, and charge for that up front regardless of what the request
actually uses. It's conservative in the "protect margin" direction, not
precise — a request with a much larger `max_tokens` than assumed is still
undercharged. The local model keeps its own flat $0.0001 floor price
instead, unrelated to this estimate.

## What's real vs. what's next

| Phase | Status |
|---|---|
| **Serve** — vLLM Metal + gpt-oss-20b, OpenAI-compatible, streaming + usage tokens | ✅ done |
| **Route** — one endpoint, 19 models, 8 upstream tiers, live health/rate-limit gating | ✅ done |
| **Pay** — x402 + USDC on Monad mainnet, flat per-request pricing, `unirouter-cli` client | ✅ live |
| **Pay** — per-token/dynamic pricing, other EVM chains | 🚧 in progress |
| **List** — feed.json entry on the Monad API Hub | ⬜ not started |

The payment layer is the actual point of this project — everything above
is the substrate it needs to exist on top of. Measurements on serving
latency, streaming-vs-prepay economics, and per-request settlement cost
are being tracked as they come in.
