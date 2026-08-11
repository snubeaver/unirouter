import { FEE_BPS, LOCAL_MODEL, UPSTREAMS, isUpstreamEnabled } from "./config.js";

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
      };
    }),
  ];

  return {
    object: "list",
    data,
    _router: { fee_bps: FEE_BPS },
  };
}
