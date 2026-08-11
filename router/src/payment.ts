import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { DEFAULT_CHAIN, PAID_LOCAL_REQUEST_PRICE } from "./config.js";

const facilitatorClient = new HTTPFacilitatorClient({ url: DEFAULT_CHAIN.facilitator_url });

// Workaround for an upstream @x402/evm@2.21.0 bug: its hardcoded Monad
// mainnet USDC metadata declares EIP-712 domain name "USD Coin", but the
// actual deployed contract's name() returns "USDC" (verified via a direct
// eth_call). The client trusts whatever `extra.name`/`extra.version` the
// server declares in the 402 challenge and signs against that domain, so
// a mismatched name here means the client signs against a domain the
// on-chain contract never had — settlement then fails with a generic
// "unexpected_error" from the facilitator, discovered while testing a
// real funded payment. Overriding the money parser lets us declare the
// correct domain without patching node_modules. Remove this once upstream
// fixes eip155:143's entry in their network metadata table.
const monadUsdcScheme = new ExactEvmScheme().registerMoneyParser(async (amount, network) => {
  if (network !== DEFAULT_CHAIN.id) return null;
  return {
    asset: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
    amount: Math.round(amount * 1_000_000).toString(), // USDC, 6 decimals
    extra: { name: "USDC", version: "2" },
  };
});

const resourceServer = new x402ResourceServer(facilitatorClient).register(DEFAULT_CHAIN.id, monadUsdcScheme);

export function localModelPaymentMiddleware() {
  const payTo = process.env.PAY_TO_ADDRESS;
  if (!payTo) {
    throw new Error("PAY_TO_ADDRESS not set — cannot start paid routes without a receiving wallet");
  }
  return paymentMiddleware(
    {
      "POST /paid/chat/completions": {
        accepts: {
          scheme: "exact",
          price: PAID_LOCAL_REQUEST_PRICE,
          network: DEFAULT_CHAIN.id,
          payTo,
        },
        description: "Flat per-request access to openai/gpt-oss-20b on local hardware",
      },
    },
    resourceServer,
  );
}
