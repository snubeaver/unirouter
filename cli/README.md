<p align="center"><img src="https://raw.githubusercontent.com/snubeaver/unirouter/main/assets/logo.svg" alt="UniRouter logo" width="96"></p>

# unirouter-cli

Pay [UniRouter](https://github.com/snubeaver/unirouter) for inference with a
wallet — no signup, no API key from us, just [x402](https://github.com/x402-foundation/x402)
on Monad mainnet.

```bash
npm install -g unirouter-cli

export WALLET_PRIVATE_KEY=0x...   # a wallet funded with real USDC on Monad mainnet

unirouter-cli chat "hello" --model gpt-5-mini
```

By default this talks to the live UniRouter instance. Pass `--url` to
point at a different instance instead.

The wallet needs real USDC on Monad mainnet, not testnet funds. No MON
needed — the facilitator pays settlement gas. `--model` takes any slug
from `GET /models` on that instance (default `openai-gpt-oss-20b`).

1. `unirouter-cli` calls the router's `/paid/<model>/chat/completions`.
2. The router replies `402 Payment Required` with an exact price, asset,
   and receiving address for that model.
3. The CLI signs an EIP-3009 `transferWithAuthorization` for that amount
   and retries the request.
4. The facilitator verifies and settles the payment on-chain, then the
   request is served.

The private key never leaves your machine; only a signed, request-scoped
payment authorization is sent over the network.

## Commands

```
unirouter-cli chat <message> [--url <url>] [--model <slug>] [--max-tokens <n>]
```

- `--url` — router base URL (default: the live UniRouter instance)
- `--model` — model slug from that instance's `/models` (default `openai-gpt-oss-20b`)
- `--max-tokens` — output token budget to buy (default `200`, max `32768`); the price scales with it

## Pricing

Each request charges upfront for the output budget set by `--max-tokens`
— the CLI sends it as the `X-Max-Tokens` header and the router prices
the 402 challenge accordingly. See
[unirouter's README](https://github.com/snubeaver/unirouter#models--pricing)
for per-model prices.
