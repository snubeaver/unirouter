import { FEE_BPS, LOCAL_MODEL, PAID_LOCAL_REQUEST_PRICE, UPSTREAMS, isUpstreamEnabled, prepayMaxPriceUsd } from "./config.js";
import { PAYABLE_MODELS } from "./payment.js";

function paymentInfo(modelId: string) {
  const payable = PAYABLE_MODELS.find((m) => m.id === modelId);
  if (!payable) return null; // beta-free: served free on /v1/chat/completions
  const price_usd = payable.entry ? prepayMaxPriceUsd(payable.entry.cost!) : Number(PAID_LOCAL_REQUEST_PRICE.slice(1));
  return { endpoint: `/paid/${payable.slug}/chat/completions`, price_usd, note: "flat prepay-max, not per-token" };
}

async function isLocalHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_MODEL.base_url}/health`, {
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
  const localAvailable = await isLocalHealthy();

  const data = [
    {
      id: LOCAL_MODEL.id,
      object: "model",
      context_length: LOCAL_MODEL.context_length,
      pricing: LOCAL_MODEL.pricing, // fixed schedule, not subject to fee_bps
      top_provider: { tier: "local" },
      status: localAvailable ? "available" : "unavailable",
      payment: paymentInfo(LOCAL_MODEL.id),
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
