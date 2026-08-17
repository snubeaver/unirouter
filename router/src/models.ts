import { DEFAULT_MAX_OUTPUT_TOKENS, FEE_BPS, UNIROUTER_MODEL, UPSTREAMS, isUpstreamEnabled } from "./config.js";
import { PAYABLE_MODELS, priceForRequest } from "./payment.js";

function paymentInfo(modelId: string) {
  const payable = PAYABLE_MODELS.find((m) => m.id === modelId);
  if (!payable) return null; // beta-free: served free on /v1/chat/completions
  const price_usd = Number(priceForRequest(payable, undefined).toFixed(6));
  return {
    endpoint: `/paid/${payable.slug}/chat/completions`,
    price_usd,
    note: `price for the default ${DEFAULT_MAX_OUTPUT_TOKENS}-token output budget; scales with the X-Max-Tokens request header`,
  };
}

async function isUniRouterModelHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${UNIROUTER_MODEL.base_url}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function withFee(perTokenUsd: string): string {
  const marked = Number(perTokenUsd) * (1 + FEE_BPS / 10_000);
  return marked.toString();
}

export async function buildModelsResponse() {
  const unirouterAvailable = await isUniRouterModelHealthy();

  const data = [
    {
      id: UNIROUTER_MODEL.id,
      object: "model",
      context_length: UNIROUTER_MODEL.context_length,
      pricing: UNIROUTER_MODEL.pricing, // fixed schedule, not subject to fee_bps
      top_provider: { tier: "unirouter" },
      status: unirouterAvailable ? "available" : "unavailable",
      payment: paymentInfo(UNIROUTER_MODEL.id),
    },
    ...UPSTREAMS.map((u) => {
      const enabled = isUpstreamEnabled(u);
      return {
        id: u.id,
        object: "model",
        context_length: u.context_length,
        pricing: u.cost
          ? { prompt: withFee(u.cost.prompt), completion: withFee(u.cost.completion) }
          : null,
        top_provider: { tier: u.tier, rate_limit_rpm: u.rate_limit_rpm },
        status: enabled ? "available" : "disabled",
        payment: paymentInfo(u.id),
      };
    }),
  ];

  return {
    object: "list",
    data,
    _router: { fee_bps: FEE_BPS },
  };
}
