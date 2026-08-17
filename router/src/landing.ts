// Public landing page for unirouter-monad.xyz, served at GET /.
// Model rows, prices, and counts are derived from config.ts at request
// time so the page can never drift from what the router actually charges.
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  FEE_BPS,
  MAX_OUTPUT_TOKENS_CEILING,
  MAX_REQUEST_BODY_BYTES,
  PREPAY_ASSUMED_PROMPT_TOKENS,
  UNIROUTER_MODEL,
  UPSTREAMS,
  UpstreamEntry,
} from "./config.js";
import { PAYABLE_MODELS, priceForRequest } from "./payment.js";
import type { Stats } from "./stats.js";

function providerName(entry: UpstreamEntry | null): string {
  if (!entry) return "UniRouter";
  const u = entry.base_url;
  if (u.includes("api.openai.com")) return "OpenAI";
  if (u.includes("anthropic.com")) return "Anthropic";
  if (u.includes("deepseek.com")) return "DeepSeek";
  if (u.includes("openrouter.ai")) return "OpenRouter";
  if (u.includes("api.x.ai")) return "xAI";
  if (u.includes("googleapis.com")) return "Google";
  if (u.includes("nvidia.com")) return "NVIDIA";
  return "Upstream";
}

function fmtContext(n: number): string {
  if (n >= 1_000_000) {
    return `${Number((n / 1_000_000).toFixed(2))}M`;
  }
  return `${Math.floor(n / 1000)}K`;
}

function fmtUsd(n: number): string {
  return `$${Number(n.toFixed(6))}`;
}

function fmtPerMillion(perToken: string): string {
  return `$${(Number(perToken) * (1 + FEE_BPS / 10_000) * 1_000_000).toFixed(2)}`;
}

const LOGO_SVG = `<svg width="24" height="24" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <g fill="#FFAE45">
    <rect x="14" y="42" width="6" height="12" rx="2"/><rect x="24" y="42" width="6" height="12" rx="2"/>
    <rect x="34" y="42" width="6" height="12" rx="2"/><rect x="43" y="42" width="6" height="12" rx="2"/>
    <rect x="8" y="24" width="44" height="22" rx="11"/><rect x="38" y="18" width="21" height="20" rx="8"/>
    <circle cx="43" cy="17" r="4"/><circle cx="53" cy="17" r="4"/>
  </g>
  <circle cx="50" cy="26" r="1.8" fill="#000000"/>
</svg>`;

// Hero mark: the capybara at 300px with three routing lines sweeping onto
// its back (route-sweep keyframes, staggered starts — from the design).
const HERO_MARK_SVG = `<svg class="hero-mark" width="300" height="300" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="UniRouter">
  <g fill="#FFAE45">
    <rect x="14" y="42" width="6" height="12" rx="2"/><rect x="24" y="42" width="6" height="12" rx="2"/>
    <rect x="34" y="42" width="6" height="12" rx="2"/><rect x="43" y="42" width="6" height="12" rx="2"/>
    <rect x="8" y="24" width="44" height="22" rx="11"/><rect x="38" y="18" width="21" height="20" rx="8"/>
    <circle cx="43" cy="17" r="4"/><circle cx="53" cy="17" r="4"/>
  </g>
  <circle cx="50" cy="26" r="1.8" fill="#000000"/>
  <path class="route-line" d="M2 13 H20" pathLength="1" stroke="#FFD199" stroke-width="2" stroke-linecap="square" stroke-dasharray="1"/>
  <path class="route-line" d="M2 7 H30" pathLength="1" stroke="#FFD199" stroke-width="2" stroke-linecap="square" stroke-dasharray="1" style="animation-delay: 0.35s;"/>
  <path class="route-line" d="M2 1 H14" pathLength="1" stroke="#FFD199" stroke-width="2" stroke-linecap="square" stroke-dasharray="1" style="animation-delay: 0.7s;"/>
</svg>`;

const ROUTES = [
  { method: "GET", path: "/models", desc: "Lists every model with live availability, its payment endpoint, and its exact per-request price." },
  { method: "POST", path: "/v1/chat/completions", desc: "OpenAI-compatible endpoint for the free models. No wallet, no key, streaming supported." },
  { method: "POST", path: "/paid/&lt;slug&gt;/chat/completions", desc: "Paid route per model. Speaks standard x402 v2 — replies 402, then serves once payment settles." },
  { method: "GET", path: "/dashboard", desc: "Live settlement activity: requests, USDC volume, and unique wallets by day." },
];

export function renderLanding(stats: Stats): string {
  const freeModels = UPSTREAMS.filter((u) => u.tier === "beta-free");
  const paidModels = PAYABLE_MODELS.map((m) => ({
    id: m.id,
    provider: providerName(m.entry),
    context: fmtContext(m.entry ? m.entry.context_length : UNIROUTER_MODEL.context_length),
    price: priceForRequest(m, undefined),
    rate: m.entry
      ? `${fmtPerMillion(m.entry.cost!.prompt)} / ${fmtPerMillion(m.entry.cost!.completion)}`
      : `${fmtPerMillion(UNIROUTER_MODEL.pricing.completion)} out beyond default`,
  })).sort((a, b) => a.price - b.price);
  const totalModels = freeModels.length + paidModels.length;
  const inputKb = Math.round(MAX_REQUEST_BODY_BYTES / 1024);

  const gpt5mini = PAYABLE_MODELS.find((m) => m.id === "gpt-5-mini");
  const examplePrice = gpt5mini ? fmtUsd(priceForRequest(gpt5mini, "4000")) : null;
  const exampleNote = examplePrice
    ? ` <code class="mds-mono-sm">gpt-5-mini</code> with <code class="mds-mono-sm">X-Max-Tokens: 4000</code> costs ${examplePrice}.`
    : "";

  const routeCards = ROUTES.map(
    (r) => `
        <div class="route-card">
          <div class="route-head">
            <span class="method">${r.method}</span>
            <code class="mds-mono">${r.path}</code>
          </div>
          <div class="mds-body-sm route-desc">${r.desc}</div>
        </div>`,
  ).join("");

  const freeRows = freeModels.map(
    (m) => `
        <div class="model-row">
          <code class="mds-mono model-id">${m.id}</code>
          <span class="mds-body-sm dim">${providerName(m)}</span>
          <span class="mds-body-sm dim">${fmtContext(m.context_length)}</span>
          <span class="mds-mono-sm free-tag">Free</span>
          <span></span>
        </div>`,
  ).join("");

  const paidRows = paidModels.map(
    (m) => `
        <div class="model-row">
          <code class="mds-mono model-id">${m.id}</code>
          <span class="mds-body-sm dim">${m.provider}</span>
          <span class="mds-body-sm dim">${m.context}</span>
          <span class="mds-mono price">${fmtUsd(m.price)}</span>
          <span class="mds-mono-sm dimmer">${m.rate}</span>
        </div>`,
  ).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UniRouter — Pay for inference without an API key</title>
<meta name="description" content="One OpenAI-compatible endpoint, ${totalModels} models, per-request USDC pricing on Monad mainnet. No signup, no API key — a funded wallet is the only credential.">
<link rel="canonical" href="https://unirouter-monad.xyz/">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<meta property="og:title" content="UniRouter">
<meta property="og:description" content="Pay for inference without an API key — x402 on Monad mainnet.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Roboto+Mono:wght@300;400;500;700&display=swap">
<style>
  :root {
    --accent: #FFAE45;
    --accent-hover: #FFC170;
    --accent-soft: #FFD199;
    --accent-border-subtle: rgba(255,174,69,0.40);
    --mds-grey-50: #FBFAF9;
    --mds-grey-400: #C7C7D6;
    --mds-grey-600: #727285;
    --mds-grey-700: #565666;
    --mds-grey-800: #353542;
    --mds-grey-900: #26262B;
    --mds-grey-950: #0F0F12;
    --bg: #000000;
    --bg-subtle: var(--mds-grey-950);
    --border: var(--mds-grey-900);
    --border-strong: var(--mds-grey-700);
    --fg: var(--mds-grey-50);
    --fg-secondary: var(--mds-grey-400);
    --fg-tertiary: var(--mds-grey-600);
    --fg-inverse: #000000;
    --status-success-fg: #22C55E;
    --font-display: 'Inter', ui-sans-serif, system-ui, sans-serif;
    --font-body: 'Inter', ui-sans-serif, system-ui, sans-serif;
    --font-mono: 'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--font-body); }
  a { color: var(--accent-hover); text-decoration: none; }
  a:hover { color: var(--accent-soft); }
  @keyframes route-sweep {
    0%   { stroke-dashoffset: 1; }
    38%  { stroke-dashoffset: 0; }
    62%  { stroke-dashoffset: 0; }
    100% { stroke-dashoffset: -1; }
  }

  .mds-h1 { font-family: var(--font-display); font-weight: 500; font-size: 64px; line-height: 72px; letter-spacing: -0.02em; }
  .mds-h2 { font-family: var(--font-display); font-weight: 500; font-size: 48px; line-height: 56px; letter-spacing: -0.015em; }
  .mds-h3 { font-family: var(--font-display); font-weight: 500; font-size: 36px; line-height: 44px; letter-spacing: -0.010em; }
  .mds-body-lg { font-family: var(--font-body); font-size: 18px; line-height: 28px; }
  .mds-body { font-family: var(--font-body); font-size: 16px; line-height: 24px; }
  .mds-body-sm { font-family: var(--font-body); font-size: 14px; line-height: 20px; }
  .mds-mono { font-family: var(--font-mono); font-size: 14px; line-height: 20px; }
  .mds-mono-sm { font-family: var(--font-mono); font-size: 12px; line-height: 16px; }
  .mds-ui-mono-xs { font-family: var(--font-mono); font-weight: 500; font-size: 9px; line-height: 11px; letter-spacing: 1.5px; text-transform: uppercase; }
  .mds-label { font-family: var(--font-mono); font-weight: 500; font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-tertiary); }
  .mds-eyebrow { font-family: var(--font-mono); font-weight: 500; font-size: 12px; line-height: 1; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-tertiary); }

  .dim { color: var(--fg-secondary); }
  .dimmer { color: var(--fg-tertiary); }
  .wrap { max-width: 1120px; margin: 0 auto; }

  header.site {
    position: sticky; top: 0; z-index: 10; height: 56px;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 32px; border-bottom: 1px solid var(--border);
    background: rgba(0,0,0,0.72); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand-name { font-family: var(--font-display); font-weight: 500; font-size: 17px; letter-spacing: -0.01em; }
  nav.site { display: flex; align-items: center; gap: 24px; }
  nav.site a.nav-link { color: var(--fg-secondary); font-size: 14px; }
  nav.site a.nav-link:hover { color: var(--fg); }
  .btn-solid {
    display: inline-flex; align-items: center; gap: 8px;
    font-family: var(--font-body); font-size: 14px; font-weight: 500;
    color: var(--fg-inverse); background: var(--accent);
    padding: 8px 14px; border-radius: 4px;
  }
  .btn-solid:hover { background: var(--accent-hover); color: var(--fg-inverse); }

  section { padding: 96px 80px; border-bottom: 1px solid var(--border); }
  section.hero {
    padding: 96px 80px 80px;
    background-image: radial-gradient(120% 90% at 15% -10%, rgba(255,174,69,0.16) 0%, rgba(0,0,0,0) 60%);
  }
  .hero-grid { display: grid; grid-template-columns: minmax(0,1fr) 300px; gap: 64px; align-items: end; }
  .hero-mark { display: block; }
  .hero-mark .route-line { animation: route-sweep 2.6s cubic-bezier(0.65, 0, 0.35, 1) infinite; }
  .hero h1 { margin: 0; max-width: 20ch; text-wrap: pretty; }
  .hero .sub { color: var(--fg-secondary); max-width: 62ch; margin: 24px 0 0; }
  .cta-row { display: flex; gap: 12px; margin-top: 40px; flex-wrap: wrap; }
  .cta {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 15px; font-weight: 500; padding: 12px 20px; border-radius: 4px;
  }
  .cta-primary { color: var(--fg-inverse); background: var(--accent); }
  .cta-primary:hover { background: var(--accent-hover); color: var(--fg-inverse); }
  .cta-outline { color: var(--fg); border: 1px solid var(--border-strong); }
  .cta-outline:hover { border-color: var(--accent-hover); color: var(--accent-soft); }
  .cta-ghost { color: var(--fg-secondary); border: 1px solid var(--border); }
  .cta-ghost:hover { color: var(--fg); border-color: var(--border-strong); }

  .stat-grid {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px;
    background: var(--border); border: 1px solid var(--border); margin-top: 72px;
  }
  .stat-cell { background: var(--bg); padding: 24px 20px; }
  .stat-cell .k { color: var(--fg-tertiary); }
  .stat-cell .v { font-family: var(--font-display); font-weight: 500; font-size: 36px; line-height: 44px; margin-top: 8px; }
  .stat-cell .v.smaller { font-size: 30px; line-height: 38px; }
  .stat-cell .d { color: var(--fg-secondary); }

  .split { display: grid; grid-template-columns: 340px 1fr; gap: 64px; align-items: start; }
  .code-card { border: 1px solid var(--border); background: var(--bg-subtle); min-width: 0; overflow: hidden; }
  .code-card .code-head { color: var(--fg-tertiary); padding: 12px 20px; border-bottom: 1px solid var(--border); }
  .code-card pre { margin: 0; padding: 20px; overflow-x: auto; color: var(--fg); font-family: var(--font-mono); font-size: 14px; line-height: 20px; }
  .code-card pre .cmt { color: var(--fg-tertiary); }

  .route-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; background: var(--border); border: 1px solid var(--border); }
  .route-card { background: var(--bg); padding: 32px; display: flex; flex-direction: column; gap: 10px; }
  .route-head { display: flex; align-items: center; gap: 10px; }
  .route-desc { color: var(--fg-secondary); max-width: 46ch; }
  .method {
    font-family: var(--font-mono); font-size: 12px; line-height: 16px;
    letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent-soft);
    border: 1px solid var(--accent-border-subtle); border-radius: 4px; padding: 3px 7px;
  }

  .table-scroll { overflow-x: auto; }
  .model-table { border: 1px solid var(--border); min-width: 720px; }
  .model-row, .model-head {
    display: grid; grid-template-columns: minmax(0,1fr) 120px 80px 120px 150px;
    gap: 16px; padding: 14px 20px; border-bottom: 1px solid var(--border); align-items: center;
  }
  .model-row:last-child { border-bottom: none; }
  .model-head { padding: 12px 20px; background: var(--bg-subtle); }
  .model-head span { color: var(--fg-tertiary); }
  .model-id { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .free-tag { letter-spacing: 0.08em; text-transform: uppercase; color: var(--status-success-fg); }
  .price { color: var(--accent-soft); }
  .footnote { color: var(--fg-tertiary); margin: 20px 0 0; max-width: 80ch; }
  code.mds-mono-sm { color: inherit; }

  section.payment { background: var(--bg-subtle); }
  .steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; }
  .step { border-top: 1px solid var(--border-strong); padding-top: 20px; }
  .step .n { color: var(--accent-soft); margin-bottom: 12px; }
  .step p { color: var(--fg-secondary); margin: 0; }
  section.payment .code-card { background: var(--bg); margin-top: 48px; }

  footer.site { padding: 64px 80px; display: flex; justify-content: space-between; align-items: flex-end; gap: 32px; flex-wrap: wrap; }
  footer.site .fine { color: var(--fg-tertiary); margin: 0; max-width: 52ch; }
  .foot-links { display: flex; gap: 24px; }

  @media (max-width: 960px) {
    section, section.hero, footer.site { padding-left: 24px; padding-right: 24px; }
    section { padding-top: 64px; padding-bottom: 64px; }
    .mds-h1 { font-size: 44px; line-height: 52px; }
    .mds-h2 { font-size: 34px; line-height: 42px; }
    .stat-grid { grid-template-columns: repeat(2, 1fr); }
    .hero-grid { grid-template-columns: 1fr; gap: 40px; }
    .hero-mark { width: 160px; height: 160px; }
    .split { grid-template-columns: 1fr; gap: 32px; }
    .route-grid { grid-template-columns: 1fr; }
    .steps { grid-template-columns: 1fr; }
    nav.site a.nav-link { display: none; }
  }
</style>
</head>
<body>

<header class="site">
  <div class="brand">${LOGO_SVG}<span class="brand-name">UniRouter</span></div>
  <nav class="site">
    <a class="nav-link" href="#endpoints">Endpoints</a>
    <a class="nav-link" href="#models">Models</a>
    <a class="nav-link" href="#payment">Payment</a>
    <a class="btn-solid" href="/dashboard">Dashboard</a>
  </nav>
</header>

<section class="hero">
  <div class="wrap">
    <div class="hero-grid">
      <div>
        <div class="mds-eyebrow" style="margin-bottom: 24px;">Inference router · x402 · Monad mainnet</div>
        <h1 class="mds-h1">Pay for inference without an API key</h1>
        <p class="mds-body-lg sub">One OpenAI-compatible endpoint, ${totalModels} models, per-request USDC pricing on Monad mainnet. No signup, no API key — a funded wallet is the only credential.</p>
        <div class="cta-row">
          <a class="cta cta-primary" href="/dashboard">Open dashboard <span aria-hidden="true">→</span></a>
          <a class="cta cta-outline" href="/models">GET /models</a>
          <a class="cta cta-ghost" href="https://github.com/snubeaver/unirouter">GitHub</a>
        </div>
      </div>
      ${HERO_MARK_SVG}
    </div>
    <div class="stat-grid">
      <div class="stat-cell">
        <div class="mds-ui-mono-xs k">Requests served</div>
        <div class="v">${stats.total_requests.toLocaleString("en-US")}</div>
        <div class="mds-body-sm d">to date</div>
      </div>
      <div class="stat-cell">
        <div class="mds-ui-mono-xs k">Starting price</div>
        <div class="v">Free</div>
        <div class="mds-body-sm d">${freeModels.length} models at $0 · no wallet needed</div>
      </div>
      <div class="stat-cell">
        <div class="mds-ui-mono-xs k">Settlement</div>
        <div class="v smaller">No gas fee needed</div>
        <div class="mds-body-sm d">you only need USDC</div>
      </div>
      <div class="stat-cell">
        <div class="mds-ui-mono-xs k">Models</div>
        <div class="v">${totalModels}</div>
        <div class="mds-body-sm d">${freeModels.length} free · ${paidModels.length} paid</div>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="wrap split">
    <div>
      <div class="mds-eyebrow" style="margin-bottom: 16px;">Quick start</div>
      <h2 class="mds-h3" style="margin: 0;">One request, one on-chain settlement.</h2>
      <p class="mds-body dim" style="margin: 16px 0 0;">The CLI fetches the 402 challenge, signs a payment authorization for the exact price, retries, and prints the reply.</p>
    </div>
    <div style="display: flex; flex-direction: column; gap: 24px; min-width: 0;">
      <div class="code-card">
        <div class="mds-ui-mono-xs code-head">Paid · CLI</div>
        <pre>npm install -g unirouter-cli
export WALLET_PRIVATE_KEY=0x...   <span class="cmt"># USDC on Monad mainnet; gas is covered by the facilitator</span>
unirouter-cli chat "hello" --model gpt-5-mini</pre>
      </div>
      <div class="code-card">
        <div class="mds-ui-mono-xs code-head">Free · no wallet</div>
        <pre>curl https://unirouter-monad.xyz/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${freeModels[0]?.id ?? "nvidia/nemotron-3-nano-30b-a3b"}", "messages": [{"role":"user","content":"hi"}], "stream": true}'</pre>
      </div>
    </div>
  </div>
</section>

<section id="endpoints">
  <div class="wrap">
    <div class="mds-eyebrow" style="margin-bottom: 16px;">§ Routes</div>
    <h2 class="mds-h2" style="margin: 0 0 48px;">Every surface the router exposes.</h2>
    <div class="route-grid">${routeCards}
    </div>
    <p class="mds-body-sm footnote">A route's slug is the model id with <code class="mds-mono-sm">/</code> replaced by <code class="mds-mono-sm">-</code> — <code class="mds-mono-sm">qwen/qwen3.7-max</code> becomes <code class="mds-mono-sm">qwen-qwen3.7-max</code>.</p>
  </div>
</section>

<section id="models">
  <div class="wrap">
    <div class="mds-eyebrow" style="margin-bottom: 16px;">§ Models &amp; pricing</div>
    <h2 class="mds-h2" style="margin: 0 0 16px;">${totalModels} models, one price list.</h2>
    <p class="mds-body dim" style="max-width: 70ch; margin: 0 0 48px;">Every paid request charges upfront for an output token budget, set by the <code class="mds-mono-sm">X-Max-Tokens</code> header (default ${DEFAULT_MAX_OUTPUT_TOKENS}, max ${MAX_OUTPUT_TOKENS_CEILING}). Input is covered up to ${PREPAY_ASSUMED_PROMPT_TOKENS} tokens (${inputKb}KB body). Prices below are at the default budget.</p>

    <div class="mds-label" style="margin-bottom: 16px;">Free</div>
    <div class="table-scroll" style="margin-bottom: 56px;">
      <div class="model-table">${freeRows}
      </div>
    </div>

    <div class="mds-label" style="margin-bottom: 16px;">Paid</div>
    <div class="table-scroll">
      <div class="model-table">
        <div class="model-head">
          <span class="mds-ui-mono-xs">Model</span>
          <span class="mds-ui-mono-xs">Provider</span>
          <span class="mds-ui-mono-xs">Context</span>
          <span class="mds-ui-mono-xs">Price / request</span>
          <span class="mds-ui-mono-xs">Rate in / out $/1M</span>
        </div>${paidRows}
      </div>
    </div>
    <p class="mds-body-sm footnote">A larger budget prices linearly:${exampleNote} Requests whose <code class="mds-mono-sm">max_tokens</code> exceed the paid budget, or whose body exceeds the input cap, are rejected with 400 before any payment is taken. <a href="/models"><code class="mds-mono-sm">GET /models</code></a> reports the exact slug and live default price for every model.</p>
  </div>
</section>

<section id="payment" class="payment">
  <div class="wrap">
    <div class="mds-eyebrow" style="margin-bottom: 16px;">§ How payment works</div>
    <h2 class="mds-h2" style="margin: 0 0 16px;">Standard x402 v2. Any client works.</h2>
    <p class="mds-body dim" style="max-width: 62ch; margin: 0 0 48px;">The private key stays on the client; only a signed, request-scoped payment authorization goes over the wire.</p>
    <div class="steps">
      <div class="step">
        <div class="mds-ui-mono-xs n">01 · Challenge</div>
        <p class="mds-body">The router replies <code class="mds-mono-sm">402</code> with a <code class="mds-mono-sm">payment-required</code> header carrying the price, the USDC asset address, and the receiving address.</p>
      </div>
      <div class="step">
        <div class="mds-ui-mono-xs n">02 · Authorize</div>
        <p class="mds-body">The client signs an EIP-3009 <code class="mds-mono-sm">transferWithAuthorization</code> for that exact amount and retries.</p>
      </div>
      <div class="step">
        <div class="mds-ui-mono-xs n">03 · Settle</div>
        <p class="mds-body">The facilitator verifies and settles on-chain (<code class="mds-mono-sm">eip155:143</code>, gas paid by the facilitator), and the request is served.</p>
      </div>
    </div>
    <div class="code-card">
      <div class="mds-ui-mono-xs code-head">Raw 402 handshake</div>
      <pre>curl -i https://unirouter-monad.xyz/paid/gpt-5-mini/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"messages": [{"role":"user","content":"hi"}], "max_tokens": 20}'</pre>
    </div>
  </div>
</section>

<footer class="site">
  <div>
    <div class="brand" style="margin-bottom: 12px;">${LOGO_SVG}<span class="brand-name">UniRouter</span></div>
    <p class="mds-body-sm fine">© 2026 UniRouter. All rights reserved.</p>
  </div>
  <div class="foot-links">
    <a class="mds-body-sm" href="https://github.com/snubeaver/unirouter">GitHub</a>
    <a class="mds-body-sm" href="https://www.npmjs.com/package/unirouter-cli">npm · unirouter-cli</a>
    <a class="mds-body-sm" href="/dashboard">Dashboard</a>
  </div>
</footer>

</body>
</html>`;
}
