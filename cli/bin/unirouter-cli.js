#!/usr/bin/env node
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const MONAD_MAINNET = "eip155:143";
const DEFAULT_URL = "https://unirouter-monad.xyz";

function printHelp() {
  console.log(`unirouter-cli chat <message> [options]

Pays a UniRouter instance for inference with a wallet via x402, on Monad
mainnet. Requires WALLET_PRIVATE_KEY in the environment — never pass a key
on the command line, it ends up in your shell history.

Options:
  --url <url>          Router base URL (default: ${DEFAULT_URL})
  --model <slug>       Model slug to pay for, from GET <url>/models
                        (default: openai-gpt-oss-20b, served by UniRouter)
  --max-tokens <n>     Output token budget to buy (default: 200, max 32768).
                        The per-request price scales with this.

Environment:
  WALLET_PRIVATE_KEY   0x-prefixed private key for the paying wallet.
                        Needs real USDC on Monad mainnet — this is real
                        money, not a testnet faucet. No MON needed: the
                        facilitator pays settlement gas, not you.
`);
}

function parseArgs(argv) {
  const args = { url: DEFAULT_URL, model: "openai-gpt-oss-20b", maxTokens: 200 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--model") args.model = argv[++i];
    else if (a === "--max-tokens") args.maxTokens = Number(argv[++i]);
    else if (a === "--help" || a === "-h") args.help = true;
    else rest.push(a);
  }
  args.positional = rest;
  return args;
}

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  const args = parseArgs(rawArgs);

  if (!command || args.help || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    process.exit(command ? 0 : 1);
  }

  if (command !== "chat") {
    console.error(`unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  const message = args.positional.join(" ");
  if (!message) {
    console.error("usage: unirouter-cli chat <message>");
    process.exit(1);
  }

  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    console.error("WALLET_PRIVATE_KEY is not set. Refusing to guess or generate one.");
    process.exit(1);
  }

  const account = privateKeyToAccount(privateKey);
  console.log(`paying from ${account.address} on Monad mainnet...`);

  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: MONAD_MAINNET, client: new ExactEvmScheme(account) }],
  });

  // X-Max-Tokens buys the output budget: the router prices the 402
  // challenge off this header, and rejects any body max_tokens above it.
  const res = await fetchWithPayment(`${args.url}/paid/${args.model}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Max-Tokens": String(args.maxTokens) },
    body: JSON.stringify({
      messages: [{ role: "user", content: message }],
      max_tokens: args.maxTokens,
    }),
  });

  if (!res.ok) {
    const paymentRequired = res.headers.get("payment-required");
    if (res.status === 402 && paymentRequired) {
      const decoded = decodePaymentResponseHeader(paymentRequired);
      console.error(`payment failed: ${decoded.error ?? "unknown reason"}`);
      if (decoded.error === "insufficient_funds") {
        console.error(`fund ${account.address} with USDC on Monad mainnet, then retry.`);
      }
    } else {
      console.error(`request failed: ${res.status} ${await res.text()}`);
    }
    process.exit(1);
  }

  const paymentResponse = res.headers.get("payment-response");
  if (paymentResponse) {
    const decoded = decodePaymentResponseHeader(paymentResponse);
    console.log("payment settled:", JSON.stringify(decoded));
  }

  const data = await res.json();
  console.log(data.choices?.[0]?.message?.content ?? JSON.stringify(data));
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
