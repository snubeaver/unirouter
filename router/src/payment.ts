import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  DEFAULT_CHAIN,
  LOCAL_MODEL,
  PAID_LOCAL_REQUEST_PRICE,
  UPSTREAMS,
  UpstreamEntry,
  prepayMaxPriceUsd,
  toSlug,
} from "./config.js";

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

export interface PayableModel {
  slug: string;
  id: string; // real model id to forward to the proxy layer
  entry: UpstreamEntry | null; // null for the local model
}

// Every paid (non-beta-free) model is payable — local at its flat
// request price, every other paid upstream at a prepay-max estimate
// (see config.ts). beta-free entries are deliberately excluded: there's
// no real cost to protect, so they stay on the open route instead of
// adding payment friction for nothing.
export const PAYABLE_MODELS: PayableModel[] = [
  { slug: toSlug(LOCAL_MODEL.id), id: LOCAL_MODEL.id, entry: null },
  ...UPSTREAMS.filter((u) => u.tier === "paid" && u.cost).map((u) => ({ slug: toSlug(u.id), id: u.id, entry: u })),
];

export function paidModelsPaymentMiddleware() {
  const payTo = process.env.PAY_TO_ADDRESS;
  if (!payTo) {
    throw new Error("PAY_TO_ADDRESS not set — cannot start paid routes without a receiving wallet");
  }

  const routes: Record<string, unknown> = {};
  for (const m of PAYABLE_MODELS) {
    const price = m.entry
      ? `$${prepayMaxPriceUsd(m.entry.cost!).toFixed(6)}`
      : PAID_LOCAL_REQUEST_PRICE;
    routes[`POST /paid/${m.slug}/chat/completions`] = {
      accepts: { scheme: "exact", price, network: DEFAULT_CHAIN.id, payTo },
      description: m.entry
        ? `Flat prepay-max access to ${m.id} via ${m.entry.provider}`
        : `Flat per-request access to ${m.id} on local hardware`,
    };
  }

  return paymentMiddleware(routes as never, resourceServer);
}
