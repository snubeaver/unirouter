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

// @x402/evm >= 2.22.0 required: earlier versions declare Monad USDC's
// EIP-712 domain name as "USD Coin" (contract says "USDC"), which breaks
// every settlement. See NOTES.md.
const resourceServer = new x402ResourceServer(facilitatorClient).register(DEFAULT_CHAIN.id, new ExactEvmScheme());

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
