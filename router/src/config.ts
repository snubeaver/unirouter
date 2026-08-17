// Central config: pricing, upstream table, fee. See CLAUDE.md "Pricing & fees"
// and "Upstream constraints" sections — this file is where those rules live,
// not scattered through route handlers.

export const FEE_BPS = 0; // never hardcode a nonzero fee elsewhere; change only here

// UniRouter's own serving node: vLLM on our hardware, reached over
// localhost:8000 from the router process.
export const UNIROUTER_MODEL = {
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

// x402 settlement chains. Monad mainnet is the only one wired up today;
// this is a table (not a single constant) on purpose — CLAUDE.md's stated
// plan is "Monad first, other EVM chains later," so adding one is meant to
// be a new entry here, not a rewrite of router/src/payment.ts.
export interface ChainEntry {
  id: `${string}:${string}`; // CAIP-2 network id, e.g. "eip155:143"
  name: string;
  facilitator_url: string;
}

export const CHAINS: ChainEntry[] = [
  {
    id: "eip155:143",
    name: "Monad mainnet",
    facilitator_url: "https://x402-facilitator.molandak.org",
  },
];

export const DEFAULT_CHAIN = CHAINS[0];

// URL-safe, single-segment identifier for a model id (many ids contain
// "/", e.g. "qwen/qwen3.7-max", which can't be a raw path segment).
export function toSlug(id: string): string {
  return id.replace(/\//g, "-");
}

// Prepay pricing. The payment layer can't see the request body when it
// prices a request, but it can see headers — so the price scales with
// the X-Max-Tokens request header (output budget the caller is buying),
// while input is a fixed assumption enforced as a body-size limit
// (estimated at 4 bytes/token). Both are enforced BEFORE payment (see
// the guard in index.ts), so a request can never cost more than it paid.
export const PREPAY_ASSUMED_PROMPT_TOKENS = 2000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 1000;
export const MAX_OUTPUT_TOKENS_CEILING = 32768;
export const MAX_REQUEST_BODY_BYTES = PREPAY_ASSUMED_PROMPT_TOKENS * 4;

export function clampOutputTokens(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_OUTPUT_TOKENS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.min(Math.floor(n), MAX_OUTPUT_TOKENS_CEILING);
}

export function upstreamPriceUsd(cost: { prompt: string; completion: string }, maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS): number {
  const raw = Number(cost.prompt) * PREPAY_ASSUMED_PROMPT_TOKENS + Number(cost.completion) * maxOutputTokens;
  return raw * (1 + FEE_BPS / 10_000);
}

// UniRouter's own model: the published $0.0001 floor covers requests up
// to the default output budget; only output beyond that accrues per-token.
export function unirouterPriceUsd(maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS): number {
  const floor = Number(UNIROUTER_MODEL.pricing.request);
  const extra = Math.max(0, maxOutputTokens - DEFAULT_MAX_OUTPUT_TOKENS) * Number(UNIROUTER_MODEL.pricing.completion);
  return floor + extra;
}

export type UpstreamTier = "unirouter" | "beta-free" | "paid";
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
  // NVIDIA build.nvidia.com catalog, beta-free tier. Restricted to actual
  // chat/instruct models — the catalog also lists embedding, reranker,
  // safety-guard, translation, and parsing models that don't work against
  // /v1/chat/completions.
  //
  // "openai/gpt-oss-20b" is also in this catalog but is not routed here:
  // it collides with UNIROUTER_MODEL's id, and serving our own model's
  // requests off NVIDIA's free dev tier would violate that tier's terms
  // (dev/eval only, not for production traffic) and contradict running
  // inference on our own hardware.
  //
  // All entries share one 20 RPM pool (`shared_rate_limit_key`) — NVIDIA's
  // own key-wide ceiling is ~40 RPM, never approach that. `cost: null`
  // since it's free; context_length is not exposed by NVIDIA's
  // /v1/models, so it's taken from each model's public card rather than
  // independently verified the way paid-upstream pricing is.
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
  // These two are the only NVIDIA models kept in the catalog: fast and
  // reliable. Other candidates tried and rejected — do not re-add without
  // re-verifying: meta/llama-3.3-70b-instruct, meta/llama-3.1-70b-instruct,
  // minimaxai/minimax-m3 (all worked but were 36-73s per request, too slow
  // for this catalog's purpose); mistralai/mistral-large-2-instruct,
  // nvidia/llama-3.1-nemotron-ultra-253b-v1, moonshotai/kimi-k2.6,
  // 01-ai/yi-large (404 "Function not found for account" — listed in the
  // catalog but not provisioned on this account); deepseek-ai/deepseek-v4-flash-0731,
  // z-ai/glm-5.2 (hung 30-300s before failing, even called directly against
  // NVIDIA, bypassing this router).
  //
  // Note: z-ai/glm-5.2 also exists as a paid OpenRouter entry above under
  // the same base id. If a free variant of an id that also has a paid
  // entry is ever added, give it a distinct id with a ":free" suffix
  // (OpenRouter's own convention) and set `upstream_model_id` to the real
  // upstream id — `UPSTREAMS.find` matches the first id it sees, so two
  // entries sharing one id makes the second unreachable.
];


export function isUpstreamEnabled(entry: UpstreamEntry): boolean {
  return Boolean(process.env[entry.kill_switch]);
}
