# UniRouter

**An inference router for anyone who can pay via x402.**

One OpenAI-compatible endpoint, 19 models, per-request USDC pricing on
Monad mainnet. No signup, no API key — a funded wallet is the only
credential.

> **Status: experimental.** Not a Monad Foundation product.

**Live endpoint:** `https://geralyn-phototelegraphic-greta.ngrok-free.dev`
([dashboard](https://geralyn-phototelegraphic-greta.ngrok-free.dev/dashboard))

[![npm](https://img.shields.io/npm/v/unirouter-cli.svg?logo=npm)](https://www.npmjs.com/package/unirouter-cli)
[![npm downloads](https://img.shields.io/npm/dm/unirouter-cli.svg)](https://www.npmjs.com/package/unirouter-cli)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white)](https://hono.dev/)
[![vLLM](https://img.shields.io/badge/vLLM-Metal-8A2BE2)](https://github.com/vllm-project/vllm)
[![x402](https://img.shields.io/badge/x402-Monad%20mainnet-brightgreen)](https://github.com/x402-foundation/x402)
[![status](https://img.shields.io/badge/status-experimental-yellow)]()

---

## Quick start

```bash
npm install -g unirouter-cli
export WALLET_PRIVATE_KEY=0x...   # USDC on Monad mainnet; gas is covered by the facilitator
unirouter-cli chat "hello" --model gpt-5-mini
```

The CLI fetches the 402 challenge, signs a payment authorization for the
exact price, retries, and prints the reply. One request, one on-chain
USDC settlement.

Free models need no wallet:

```bash
curl https://geralyn-phototelegraphic-greta.ngrok-free.dev/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "nvidia/nemotron-3-nano-30b-a3b", "messages": [{"role":"user","content":"hi"}], "stream": true}'
```

## Models & pricing

`GET /models` lists every model with live availability, its payment
endpoint, and its exact per-request price.

### Free — `POST /v1/chat/completions`

| Model | Provider | Context |
|---|---|---|
| `nvidia/nemotron-3-nano-30b-a3b` | NVIDIA | 128K |
| `nvidia/nemotron-3-super-120b-a12b` | NVIDIA | 128K |

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

A route's `<slug>` is the model id with `/` replaced by `-`
(`qwen/qwen3.7-max` → `qwen-qwen3.7-max`).

Each paid request charges a flat amount upfront: $0.0001 for the local
model, and for every other model a prepay-max estimate of 500 input +
1000 output tokens at the per-token rates above.

## How payment works

Paid routes speak standard x402 v2, so any x402 client works — not just
the CLI:

```bash
curl -i https://geralyn-phototelegraphic-greta.ngrok-free.dev/paid/gpt-5-mini/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role":"user","content":"hi"}], "max_tokens": 20}'
```

1. The router replies `402` with a `payment-required` header carrying the
   price, the USDC asset address, and the receiving address.
2. The client signs an EIP-3009 `transferWithAuthorization` for that
   exact amount and retries.
3. The facilitator verifies and settles on-chain (`eip155:143`, gas paid
   by the facilitator), and the request is served.

The private key stays on the client; only a signed, request-scoped
payment authorization goes over the wire.

## Self-hosting

The router is a single Node process that proxies to a local
[vLLM](https://github.com/vllm-project/vllm) instance and seven upstream
providers — it runs no models itself.

```bash
cd router
npm install
cp .env.example .env   # add keys for whichever upstreams you want live, plus PAY_TO_ADDRESS
npm run start          # http://localhost:3402
```

Upstreams without an API key report `"status": "disabled"` on `/models`
and return `503` if called. Pricing, the upstream table, and the
`fee_bps` markup (currently `0`) live in `router/src/config.ts`.
