// Central config: pricing, upstream table, fee. See CLAUDE.md "Pricing & fees"
// and "Upstream constraints" sections — this file is where those rules live,
// not scattered through route handlers.

export const FEE_BPS = 0; // never hardcode a nonzero fee elsewhere; change only here

export const LOCAL_MODEL = {
  id: "openai/gpt-oss-20b",
  context_length: 32768,
  base_url: "http://localhost:8000",
  // hybrid per-request floor + per-token, pegged to OpenRouter market median
  pricing: {
    request: "0.0001", // USD floor per request
    prompt: "0.00000003", // USD per input token ($0.03 / 1M)
    completion: "0.00000013", // USD per output token ($0.13 / 1M)
  },
} as const;

export type UpstreamTier = "local" | "beta-free" | "paid";
export type ProviderFormat = "openai-compatible" | "anthropic-native";

export interface UpstreamEntry {
  id: string;
  tier: UpstreamTier;
  provider: ProviderFormat;
  base_url: string;
  completions_path?: string; // default "/v1/chat/completions"; override for providers that don't use that path (e.g. DeepSeek's "/chat/completions")
  // gpt-5-family models reject `max_tokens` ("use max_completion_tokens
  // instead") — rename the field before forwarding when set.
  rename_max_tokens_to_completion?: boolean;
  // The model id to actually send to the upstream, if different from `id`
  // (our public-facing name). Needed for ids like "z-ai/glm-5.2:free" —
  // the ":free" suffix disambiguates it from the paid entry in OUR table,
  // but NVIDIA itself has never heard of that suffix and would 404.
  upstream_model_id?: string;
  kill_switch: string; // env var name; route is disabled if unset/falsy
  rate_limit_rpm: number;
  // Rate-limit bucket key. Defaults to `id` (per-model cap). Set this to a
  // shared string across entries that must share ONE pool's RPM budget —
  // e.g. NVIDIA's beta-free catalog, where CLAUDE.md caps the whole
  // catalog at 20 RPM total, not 20 RPM per model.
  shared_rate_limit_key?: string;
  context_length: number;
  // cost pass-through pricing (USD per token, pre-fee_bps markup); null for
  // beta-free tiers with no real cost to pass through
  cost: { prompt: string; completion: string } | null;
  price_verified_at: string; // ISO date; refreshed by the daily pricing-check job
}

// Verified 2026-08-11 against developers.openai.com/api/docs/pricing and
// platform.claude.com/docs/en/about-claude/pricing (cross-checked with two
// independent fetches each — do not hand-edit these numbers without
// re-verifying against the provider's own pricing page).
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com";
export const NVIDIA_SHARED_RATE_LIMIT_KEY = "nvidia-beta-free";
export const NVIDIA_SHARED_RATE_LIMIT_RPM = 20;

export const UPSTREAMS: UpstreamEntry[] = [
  {
    id: "gpt-5.5",
    tier: "paid",
    provider: "openai-compatible",
    base_url: "https://api.openai.com",
    rename_max_tokens_to_completion: true,
    kill_switch: "OPENAI_API_KEY",
    rate_limit_rpm: 60,
    context_length: 1_050_000,
    cost: { prompt: "0.000005", completion: "0.00003" },
    price_verified_at: "2026-08-11",
  },
  {
    id: "gpt-5.1",
    tier: "paid",
    provider: "openai-compatible",
    base_url: "https://api.openai.com",
    rename_max_tokens_to_completion: true,
    kill_switch: "OPENAI_API_KEY",
    rate_limit_rpm: 60,
    context_length: 400_000,
    cost: { prompt: "0.00000125", completion: "0.00001" },
    price_verified_at: "2026-08-11",
  },
  {
    id: "gpt-5-mini",
    tier: "paid",
    provider: "openai-compatible",
    base_url: "https://api.openai.com",
    rename_max_tokens_to_completion: true,
    kill_switch: "OPENAI_API_KEY",
    rate_limit_rpm: 60,
    context_length: 400_000,
    cost: { prompt: "0.00000025", completion: "0.000002" },
    price_verified_at: "2026-08-11",
  },
  {
    id: "claude-opus-5",
    tier: "paid",
    provider: "anthropic-native",
    base_url: "https://api.anthropic.com",
    kill_switch: "ANTHROPIC_API_KEY",
    rate_limit_rpm: 60,
    context_length: 1_000_000,
    cost: { prompt: "0.000005", completion: "0.000025" },
    price_verified_at: "2026-08-11",
  },
  {
    // Introductory pricing ($2/$10) through 2026-08-31, then $3/$15 —
    // exactly the kind of change the daily pricing-check job exists to catch.
    id: "claude-sonnet-5",
    tier: "paid",
    provider: "anthropic-native",
    base_url: "https://api.anthropic.com",
    kill_switch: "ANTHROPIC_API_KEY",
    rate_limit_rpm: 60,
    context_length: 1_000_000,
    cost: { prompt: "0.000002", completion: "0.00001" },
    price_verified_at: "2026-08-11",
  },
  {
    id: "claude-haiku-4-5-20251001",
    tier: "paid",
    provider: "anthropic-native",
    base_url: "https://api.anthropic.com",
    kill_switch: "ANTHROPIC_API_KEY",
    rate_limit_rpm: 60,
    context_length: 200_000,
    cost: { prompt: "0.000001", completion: "0.000005" },
    price_verified_at: "2026-08-11",
  },
  // DeepSeek direct — real cost pass-through. Their API uses "/chat/completions",
  // not the "/v1/chat/completions" every other upstream here uses. Input
  // pricing below is cache-miss (standard) rate; DeepSeek also offers a
  // cheaper cache-hit rate ($0.0028-$0.003625/1M) that this router doesn't
  // yet pass through since there's no cache-awareness in the routing layer.
  {
    id: "deepseek-v4-flash",
    tier: "paid",
    provider: "openai-compatible",
    base_url: "https://api.deepseek.com",
    completions_path: "/chat/completions",
    kill_switch: "DEEPSEEK_API_KEY",
    rate_limit_rpm: 60,
    context_length: 1_000_000,
    cost: { prompt: "0.00000014", completion: "0.00000028" },
    price_verified_at: "2026-08-11",
  },
  {
    id: "deepseek-v4-pro",
    tier: "paid",
    provider: "openai-compatible",
    base_url: "https://api.deepseek.com",
    completions_path: "/chat/completions",
    kill_switch: "DEEPSEEK_API_KEY",
    rate_limit_rpm: 60,
    context_length: 1_000_000,
    cost: { prompt: "0.000000435", completion: "0.00000087" },
    price_verified_at: "2026-08-11",
  },
  // Chinese open models via OpenRouter (decided against NVIDIA's beta-free
  // catalog for these — OpenRouter is already OpenAI-compatible with a
  // public, authoritative `GET /api/v1/models` pricing feed, so no guessing
  // at model IDs). Flagship-tier pick per lab, verified 2026-08-11 directly
  // against https://openrouter.ai/api/v1/models (live, no scraping).
  {
    id: "qwen/qwen3.7-max",
    tier: "paid",
    provider: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
    completions_path: "/chat/completions",
    kill_switch: "OPENROUTER_API_KEY",
    rate_limit_rpm: 60,
    context_length: 1_000_000,
    cost: { prompt: "0.000001475", completion: "0.000004425" },
    price_verified_at: "2026-08-11",
  },
  {
    id: "moonshotai/kimi-k3",
    tier: "paid",
    provider: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
    completions_path: "/chat/completions",
    kill_switch: "OPENROUTER_API_KEY",
    rate_limit_rpm: 60,
    context_length: 1_048_576,
    cost: { prompt: "0.000003", completion: "0.000015" },
    price_verified_at: "2026-08-11",
  },
  {
    id: "z-ai/glm-5.2",
    tier: "paid",
    provider: "openai-compatible",
    base_url: "https://openrouter.ai/api/v1",
    completions_path: "/chat/completions",
    kill_switch: "OPENROUTER_API_KEY",
    rate_limit_rpm: 60,
    context_length: 1_048_576,
    cost: { prompt: "0.0000004886", completion: "0.0000015356" },
    price_verified_at: "2026-08-11",
  },
  // Grok (xAI) — pricing pulled live from GET https://api.x.ai/v1/models
  // (authoritative, not scraped) and converted from their raw
  // "token_price" units (1 unit = $0.0001 per 1M tokens) to USD/token.
  // Short-context tier only; long-context (>200k input) tier roughly
  // doubles both input and output price and isn't modeled here.
  {
    id: "grok-4.5",
    tier: "paid",
    provider: "openai-compatible",
    base_url: "https://api.x.ai/v1",
    completions_path: "/chat/completions",
    kill_switch: "GROK_API_KEY",
    rate_limit_rpm: 60,
    context_length: 500_000,
    cost: { prompt: "0.000002", completion: "0.000006" },
    price_verified_at: "2026-08-11",
  },
  {
    id: "grok-4.3",
    tier: "paid",
    provider: "openai-compatible",
    base_url: "https://api.x.ai/v1",
    completions_path: "/chat/completions",
    kill_switch: "GROK_API_KEY",
    rate_limit_rpm: 60,
    context_length: 1_000_000,
    cost: { prompt: "0.00000125", completion: "0.0000025" },
    price_verified_at: "2026-08-11",
  },
  // Gemini — via Google's OpenAI-compatible endpoint. Context limits pulled
  // live from GET https://generativelanguage.googleapis.com/v1beta/models
  // (authoritative); per-token pricing from ai.google.dev/gemini-api/docs/pricing.
  {
    id: "gemini-3.1-pro-preview",
    tier: "paid",
    provider: "openai-compatible",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    completions_path: "/chat/completions",
    kill_switch: "GEMINI_API_KEY",
    rate_limit_rpm: 60,
    context_length: 1_048_576,
    cost: { prompt: "0.000002", completion: "0.000012" },
    price_verified_at: "2026-08-11",
  },
  {
    id: "gemini-3.6-flash",
    tier: "paid",
    provider: "openai-compatible",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    completions_path: "/chat/completions",
    kill_switch: "GEMINI_API_KEY",
    rate_limit_rpm: 60,
    context_length: 1_048_576,
    cost: { prompt: "0.0000015", completion: "0.0000075" },
    price_verified_at: "2026-08-11",
  },
  {
    id: "gemini-3.5-flash-lite",
    tier: "paid",
    provider: "openai-compatible",
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    completions_path: "/chat/completions",
    kill_switch: "GEMINI_API_KEY",
    rate_limit_rpm: 60,
    context_length: 1_048_576,
    cost: { prompt: "0.0000003", completion: "0.0000025" },
    price_verified_at: "2026-08-11",
  },
  // NVIDIA build.nvidia.com catalog — beta-free tier, see CLAUDE.md
  // "Upstream constraints". Model IDs pulled live from
  // `GET https://integrate.api.nvidia.com/v1/models` on 2026-08-12 (real
  // API call, not a third-party listing) and filtered by hand to actual
  // chat/instruct models — the catalog also lists embedding, reranker,
  // safety-guard, translation, and parsing models that don't work against
  // /v1/chat/completions, and those are deliberately excluded.
  //
  // Deliberately NOT added: "openai/gpt-oss-20b" IS in this free catalog,
  // but that id collides with LOCAL_MODEL — routing it here would mean
  // silently serving our own paid model's requests off NVIDIA's free dev
  // tier instead of our own hardware, which is both a likely ToS violation
  // (their free tier is dev/beta/eval only, not for serving paying traffic)
  // and directly contradicts this project's whole premise of running real
  // inference on our own hardware. Left out on purpose, not an oversight.
  //
  // All entries share ONE 20 RPM pool (`shared_rate_limit_key`) per
  // CLAUDE.md's self-imposed cap — NVIDIA's own key-wide ceiling is ~40 RPM;
  // never approach that from our side. `cost: null` since it's free;
  // context_length values not exposed by NVIDIA's /v1/models (no pricing/
  // spec metadata in that response) — filled in from each model's own
  // public model card / general knowledge, not independently re-verified
  // the way the paid upstreams' pricing was.
  {
    id: "nvidia/nemotron-3-super-120b-a12b",
    tier: "beta-free",
    provider: "openai-compatible",
    base_url: NVIDIA_BASE_URL,
    kill_switch: "NVIDIA_API_KEY",
    rate_limit_rpm: NVIDIA_SHARED_RATE_LIMIT_RPM,
    shared_rate_limit_key: NVIDIA_SHARED_RATE_LIMIT_KEY,
    context_length: 128_000,
    cost: null,
    price_verified_at: "2026-08-12",
  },
  {
    id: "nvidia/nemotron-3-nano-30b-a3b",
    tier: "beta-free",
    provider: "openai-compatible",
    base_url: NVIDIA_BASE_URL,
    kill_switch: "NVIDIA_API_KEY",
    rate_limit_rpm: NVIDIA_SHARED_RATE_LIMIT_RPM,
    shared_rate_limit_key: NVIDIA_SHARED_RATE_LIMIT_KEY,
    context_length: 128_000,
    cost: null,
    price_verified_at: "2026-08-12",
  },
  // Jeffui: keep this list tight ("나머지 지원하는거 좀 오바임") — only these
  // two, both fast/reliable in testing. meta/llama-3.3-70b-instruct (~73s),
  // meta/llama-3.1-70b-instruct, and minimaxai/minimax-m3 (~36s) all worked
  // but were cut for being slow/unnecessary breadth, not for being broken.
  //
  // z-ai/glm-5.2 also exists as a paid entry via OpenRouter above, same id.
  // Suffixed ":free" (OpenRouter's own convention for free-tier variants,
  // reused here on purpose so it's a familiar pattern) so a caller can
  // explicitly request the free NVIDIA path and always get it — without
  // the suffix, `UPSTREAMS.find` would return whichever entry is listed
  // first, which is exactly the bug that shipped initially (the free
  // entry was unreachable, silently shadowed by the paid one). NOTE:
  // z-ai/glm-5.2:free was originally added here with the fix above, but
  // pulled again minutes later — a direct call to NVIDIA (bypassing our
  // router) for z-ai/glm-5.2 hung for 301 seconds before failing outright
  // ("fetch failed"). GLM is only offered via the OpenRouter paid entry
  // now; `upstream_model_id` (the mechanism this fix introduced) stays in
  // the type for the next time an id needs a `:free`-style public alias.
  //
  // Confirmed NOT usable on this NVIDIA account as of 2026-08-12 — kept out
  // rather than added-then-silently-broken:
  // mistralai/mistral-large-2-instruct, nvidia/llama-3.1-nemotron-ultra-253b-v1,
  // moonshotai/kimi-k2.6, 01-ai/yi-large all returned HTTP 404
  // "Function ... Not found for account" (listed in the catalog but not
  // actually provisioned for this key). deepseek-ai/deepseek-v4-flash-0731
  // and z-ai/glm-5.2 both hung for 30s-300s before erroring, even called
  // directly against NVIDIA — worse than a clean 404, so excluded rather
  // than left in to intermittently hang real requests.
];


export function isUpstreamEnabled(entry: UpstreamEntry): boolean {
  return Boolean(process.env[entry.kill_switch]);
}
