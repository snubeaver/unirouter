# unirouter-cli

Pay [UniRouter](https://github.com/snubeaver/unirouter) for inference with a
wallet — no signup, no API key from us, just [x402](https://github.com/x402-foundation/x402)
on Monad mainnet.

```bash
npm install -g unirouter-cli

export WALLET_PRIVATE_KEY=0x...   # a wallet funded with real USDC on Monad mainnet

unirouter-cli chat "hello" --url https://your-unirouter-instance.example
```

The wallet needs to hold **real USDC** on Monad mainnet — this is not a
testnet faucet flow. You don't need MON for gas: the facilitator relays
and pays for settlement. On a request:

1. `unirouter-cli` calls the router's `/paid/chat/completions`.
2. The router replies `402 Payment Required` with an exact price, asset,
   and receiving address.
3. The CLI signs an EIP-3009 `transferWithAuthorization` for that exact
   amount with your private key and retries the request.
4. The router's facilitator verifies and settles the payment on-chain,
   then the request is served.

No private key ever leaves your machine except as a signed payment
authorization scoped to the exact price of that one request.

## Commands

```
unirouter-cli chat <message> [--url <url>] [--max-tokens <n>]
```

- `--url` — router base URL (default `http://localhost:3402`)
- `--max-tokens` — default `200`

## Why request-flat pricing

Today's charge is a flat per-request amount, not per-token — the x402
payment layer decides price before it can see your request body, so it
can't yet price by model or token count. See
[unirouter's README](https://github.com/snubeaver/unirouter#why-flat-rate-not-per-token)
for the actual reason.
