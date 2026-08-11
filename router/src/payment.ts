import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { DEFAULT_CHAIN, PAID_LOCAL_REQUEST_PRICE } from "./config.js";

const facilitatorClient = new HTTPFacilitatorClient({ url: DEFAULT_CHAIN.facilitator_url });

const resourceServer = new x402ResourceServer(facilitatorClient).register(DEFAULT_CHAIN.id, new ExactEvmScheme());

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
