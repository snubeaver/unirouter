import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  DEFAULT_CHAIN,
  UNIROUTER_MODEL,
  UPSTREAMS,
  UpstreamEntry,
  clampOutputTokens,
  toSlug,
  unirouterPriceUsd,
  upstreamPriceUsd,
} from "./config.js";

const facilitatorClient = new HTTPFacilitatorClient({ url: DEFAULT_CHAIN.facilitator_url });

// @x402/evm >= 2.22.0 required: earlier versions declare Monad USDC's
// EIP-712 domain name as "USD Coin" (contract says "USDC"), which breaks
// every settlement. See NOTES.md.
const resourceServer = new x402ResourceServer(facilitatorClient).register(DEFAULT_CHAIN.id, new ExactEvmScheme());

export interface PayableModel {
  slug: string;
  id: string; // real model id to forward to the proxy layer
  entry: UpstreamEntry | null; // null for UniRouter's own model
}

// Every paid (non-beta-free) model is payable. beta-free entries are
// deliberately excluded: there's no real cost to protect, so they stay
// on the open route instead of adding payment friction for nothing.
export const PAYABLE_MODELS: PayableModel[] = [
  { slug: toSlug(UNIROUTER_MODEL.id), id: UNIROUTER_MODEL.id, entry: null },
  ...UPSTREAMS.filter((u) => u.tier === "paid" && u.cost).map((u) => ({ slug: toSlug(u.id), id: u.id, entry: u })),
];

export function priceForRequest(model: PayableModel, maxTokensHeader: string | undefined): number {
  const outputTokens = clampOutputTokens(maxTokensHeader);
  return model.entry ? upstreamPriceUsd(model.entry.cost!, outputTokens) : unirouterPriceUsd(outputTokens);
}

export function paidModelsPaymentMiddleware() {
  const payTo = process.env.PAY_TO_ADDRESS;
  if (!payTo) {
    throw new Error("PAY_TO_ADDRESS not set — cannot start paid routes without a receiving wallet");
  }

  const routes: Parameters<typeof paymentMiddleware>[0] = {};
  for (const m of PAYABLE_MODELS) {
    routes[`POST /paid/${m.slug}/chat/completions`] = {
      accepts: {
        scheme: "exact",
        // Price scales with the output budget the caller buys via the
        // X-Max-Tokens request header (default 1000). Deterministic in the
        // header value, so the 402 challenge and the paid retry price the
        // same request identically.
        price: (ctx) => `$${priceForRequest(m, ctx.adapter.getHeader("x-max-tokens")).toFixed(6)}`,
        network: DEFAULT_CHAIN.id,
        payTo,
      },
      description: m.entry
        ? `Per-request access to ${m.id} via ${m.entry.provider}`
        : `Per-request access to ${m.id} served by UniRouter`,
    };
  }

  return paymentMiddleware(routes, resourceServer);
}
