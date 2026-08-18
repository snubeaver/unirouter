// Dashboard at GET /dashboard: x402 settlement activity rendered from the
// router's own payment log. Same visual system as landing.ts (dark MDS
// tokens, orange accent); charts are plain CSS flex bars, no client JS.
import type { Stats } from "./stats.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
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

// Daily bar chart: 4 y-axis ticks at thirds of the max, gridlines every
// third of the 180px plot via repeating-linear-gradient, one flex bar per day.
function dailyBarChart(title: string, byDay: Stats["by_day"], values: number[], color: string): string {
  if (byDay.length === 0) {
    return `
      <div class="chart-card">
        <div class="chart-head"><div class="mds-ui-mono-xs dimmer">${escapeHtml(title)}</div></div>
        <p class="mds-body-sm empty">No requests yet.</p>
      </div>`;
  }

  const max = Math.max(1, ...values);
  const ticks = [max, Math.round((max * 2) / 3), Math.round(max / 3), 0];
  const showEvery = Math.max(1, Math.ceil(byDay.length / 10));

  const bars = values
    .map(
      (v) => `
              <div class="bar-slot"><div class="bar" style="background: ${color}; height: ${((v / max) * 100).toFixed(1)}%;"></div></div>`,
    )
    .join("");
  const labels = byDay
    .map((d, i) => {
      const text = i % showEvery === 0 || i === byDay.length - 1 ? escapeHtml(d.date.slice(5)) : "";
      return `<span class="mds-mono-xs bar-label">${text}</span>`;
    })
    .join("");

  return `
      <div class="chart-card">
        <div class="chart-head"><div class="mds-ui-mono-xs dimmer">${escapeHtml(title)}</div></div>
        <div class="chart-grid">
          <div class="y-axis">${ticks.map((t) => `<span class="mds-mono-xs">${t}</span>`).join("")}</div>
          <div>
            <div class="plot">${bars}
            </div>
            <div class="x-axis">${labels}</div>
          </div>
        </div>
      </div>`;
}

// Cumulative line chart in the same card frame as the bar charts: an SVG
// with normalized coordinates stretched over the 180px plot, so the
// gridlines and y-axis stay identical to the bar variant.
function cumulativeLineChart(title: string, byDay: Stats["by_day"], values: number[], color: string): string {
  if (byDay.length === 0) {
    return `
      <div class="chart-card">
        <div class="chart-head"><div class="mds-ui-mono-xs dimmer">${escapeHtml(title)}</div></div>
        <p class="mds-body-sm empty">No requests yet.</p>
      </div>`;
  }

  const max = Math.max(1, ...values);
  const ticks = [max, Math.round((max * 2) / 3), Math.round(max / 3), 0];
  const showEvery = Math.max(1, Math.ceil(byDay.length / 10));

  const pt = (v: number, i: number): string => {
    const x = values.length === 1 ? 50 : (i / (values.length - 1)) * 100;
    const y = 100 - (v / max) * 100;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  };
  const points = values.length === 1 ? `0,${pt(values[0], 0).split(",")[1]} 100,${pt(values[0], 0).split(",")[1]}` : values.map(pt).join(" ");
  const area = `0,100 ${points} 100,100`;

  const labels = byDay
    .map((d, i) => {
      const text = i % showEvery === 0 || i === byDay.length - 1 ? escapeHtml(d.date.slice(5)) : "";
      return `<span class="mds-mono-xs bar-label">${text}</span>`;
    })
    .join("");

  return `
      <div class="chart-card">
        <div class="chart-head">
          <div class="mds-ui-mono-xs dimmer">${escapeHtml(title)}</div>
          <div class="mds-mono-xs dimmer">${max.toLocaleString("en-US")} to date</div>
        </div>
        <div class="chart-grid">
          <div class="y-axis">${ticks.map((t) => `<span class="mds-mono-xs">${t}</span>`).join("")}</div>
          <div>
            <div class="plot">
              <svg class="line-svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(title)}">
                <polygon points="${area}" fill="${color}" opacity="0.12"/>
                <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
              </svg>
            </div>
            <div class="x-axis">${labels}</div>
          </div>
        </div>
      </div>`;
}

function modelRows(byModel: Stats["by_model"]): string {
  if (byModel.length === 0) {
    return `<p class="mds-body-sm empty" style="padding: 18px 24px;">No requests yet.</p>`;
  }
  const max = Math.max(...byModel.map((m) => m.count));
  return byModel
    .map((m) => {
      const pct = Math.max((m.count / max) * 100, 0.5).toFixed(1);
      return `
        <div class="model-row">
          <div class="model-cells">
            <code class="mds-mono model-id">${escapeHtml(m.model)}</code>
            <span class="mds-mono num">${m.count.toLocaleString("en-US")}</span>
            <span class="mds-mono num volume">${fmtUsd(m.volume_usd)}</span>
          </div>
          <div class="track"><div class="fill" style="width: ${pct}%;"></div></div>
        </div>`;
    })
    .join("");
}

export function renderDashboard(stats: Stats): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UniRouter — Dashboard</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Roboto+Mono:wght@300;400;500;700&display=swap">
<style>
  :root {
    --accent: #FFAE45;
    --accent-hover: #FFC170;
    --accent-soft: #FFD199;
    --mds-grey-50: #FBFAF9;
    --mds-grey-400: #C7C7D6;
    --mds-grey-600: #727285;
    --mds-grey-700: #565666;
    --mds-grey-900: #26262B;
    --mds-grey-950: #0F0F12;
    --bg: #000000;
    --bg-subtle: var(--mds-grey-950);
    --border: var(--mds-grey-900);
    --border-strong: var(--mds-grey-700);
    --fg: var(--mds-grey-50);
    --fg-secondary: var(--mds-grey-400);
    --fg-tertiary: var(--mds-grey-600);
    --status-success-fg: #22C55E;
    --font-display: 'Inter', ui-sans-serif, system-ui, sans-serif;
    --font-body: 'Inter', ui-sans-serif, system-ui, sans-serif;
    --font-mono: 'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font-family: var(--font-body); }
  a { color: var(--accent-hover); text-decoration: none; }
  a:hover { color: var(--accent-soft); }

  .mds-h2 { font-family: var(--font-display); font-weight: 500; font-size: 48px; line-height: 56px; letter-spacing: -0.015em; }
  .mds-body { font-family: var(--font-body); font-size: 16px; line-height: 24px; }
  .mds-body-sm { font-family: var(--font-body); font-size: 14px; line-height: 20px; }
  .mds-mono { font-family: var(--font-mono); font-size: 14px; line-height: 20px; }
  .mds-mono-xs { font-family: var(--font-mono); font-size: 11px; line-height: 14px; }
  .mds-ui-mono-xs { font-family: var(--font-mono); font-weight: 500; font-size: 9px; line-height: 11px; letter-spacing: 1.5px; text-transform: uppercase; }
  .mds-eyebrow { font-family: var(--font-mono); font-weight: 500; font-size: 12px; line-height: 1; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-tertiary); }
  .dimmer { color: var(--fg-tertiary); }
  .wrap { max-width: 1120px; margin: 0 auto; }

  header.site {
    position: sticky; top: 0; z-index: 10; height: 56px;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 32px; border-bottom: 1px solid var(--border);
    background: rgba(0,0,0,0.72); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  a.brand, a.brand:hover { color: var(--fg); }
  .brand-name { font-family: var(--font-display); font-weight: 500; font-size: 17px; letter-spacing: -0.01em; }
  .crumb { font-family: var(--font-mono); font-size: 12px; line-height: 16px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--fg-tertiary); margin-left: 8px; }
  nav.site { display: flex; align-items: center; gap: 24px; }
  nav.site a.nav-link { color: var(--fg-secondary); font-size: 14px; }
  nav.site a.nav-link:hover { color: var(--fg); }
  .status-pill {
    display: flex; align-items: center; gap: 8px;
    font-family: var(--font-mono); font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--status-success-fg); border: 1px solid var(--border); border-radius: 4px; padding: 5px 10px;
  }

  section { padding: 0 80px 40px; }
  section.head { padding: 64px 80px 40px; }
  section.head h1 { margin: 0 0 12px; }
  section.head p { color: var(--fg-secondary); margin: 0; }

  .stat-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--border); border: 1px solid var(--border); }
  .stat-cell { background: var(--bg); padding: 28px 24px; }
  .stat-cell .v { font-family: var(--font-display); font-weight: 500; font-size: 48px; line-height: 56px; margin-top: 10px; }
  .stat-cell .v.volume { color: var(--accent); }

  .chart-grid-outer { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; background: var(--border); border: 1px solid var(--border); }
  .chart-card { background: var(--bg); padding: 28px 24px; min-width: 0; }
  .chart-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 28px; }
  .chart-grid { display: grid; grid-template-columns: 44px minmax(0,1fr); gap: 12px; }
  .y-axis { display: flex; flex-direction: column; justify-content: space-between; height: 180px; }
  .y-axis span { color: var(--fg-tertiary); text-align: right; }
  .plot {
    display: flex; align-items: flex-end; gap: 10px; height: 180px;
    border-bottom: 1px solid var(--border-strong);
    background-image: repeating-linear-gradient(to top, transparent 0 59px, var(--border) 59px 60px);
  }
  .bar-slot { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
  .bar { width: 100%; }
  .line-svg { width: 100%; height: 100%; display: block; }
  .x-axis { display: flex; gap: 10px; margin-top: 10px; }
  .bar-label { flex: 1; min-width: 0; text-align: center; color: var(--fg-tertiary); overflow: hidden; }
  .empty { color: var(--fg-tertiary); }

  .model-table { border: 1px solid var(--border); overflow: hidden; }
  .model-head, .model-cells { display: grid; grid-template-columns: minmax(0,1fr) 120px 120px; gap: 16px; align-items: baseline; }
  .model-head { padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--bg-subtle); }
  .model-head span { color: var(--fg-tertiary); }
  .model-head .right { text-align: right; }
  .model-row { padding: 18px 24px; border-bottom: 1px solid var(--border); }
  .model-row:last-child { border-bottom: none; }
  .model-id { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .num { color: var(--fg); text-align: right; }
  .num.volume { color: var(--accent-hover); }
  .track { height: 4px; background: var(--bg-subtle); margin-top: 14px; }
  .fill { height: 4px; background: var(--accent); }
  .footnote { color: var(--fg-tertiary); margin: 20px 0 0; }

  footer.site { padding: 48px 80px 64px; border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: flex-end; gap: 32px; flex-wrap: wrap; }
  footer.site p { color: var(--fg-tertiary); margin: 0; }
  .foot-links { display: flex; gap: 24px; }

  @media (max-width: 960px) {
    section, section.head, footer.site { padding-left: 24px; padding-right: 24px; }
    .mds-h2 { font-size: 34px; line-height: 42px; }
    .stat-grid { grid-template-columns: 1fr; }
    .chart-grid-outer { grid-template-columns: 1fr; }
    nav.site a.nav-link { display: none; }
  }
</style>
</head>
<body>

<header class="site">
  <a class="brand" href="/">${LOGO_SVG}<span class="brand-name">UniRouter</span><span class="crumb">› Dashboard</span></a>
  <nav class="site">
    <a class="nav-link" href="/">Overview</a>
    <a class="nav-link" href="/models">GET /models</a>
    <span class="status-pill">████ Online</span>
  </nav>
</header>

<section class="head">
  <div class="wrap">
    <div class="mds-eyebrow" style="margin-bottom: 16px;">§ x402 settlement activity</div>
    <h1 class="mds-h2">Live from the router's own payment log.</h1>
    <p class="mds-body">Totals, the daily series, and the model breakdown are settled on-chain payments.</p>
  </div>
</section>

<section>
  <div class="wrap stat-grid">
    <div class="stat-cell">
      <div class="mds-ui-mono-xs dimmer">Total requests</div>
      <div class="v">${stats.total_requests.toLocaleString("en-US")}</div>
    </div>
    <div class="stat-cell">
      <div class="mds-ui-mono-xs dimmer">Total volume</div>
      <div class="v volume">${fmtUsd(stats.total_volume_usd)}</div>
    </div>
    <div class="stat-cell">
      <div class="mds-ui-mono-xs dimmer">Unique wallets</div>
      <div class="v">${stats.unique_wallets.toLocaleString("en-US")}</div>
    </div>
  </div>
</section>

<section>
  <div class="wrap chart-grid-outer">${dailyBarChart("Requests per day", stats.by_day, stats.by_day.map((d) => d.requests), "var(--accent)")}${cumulativeLineChart("Unique wallets · cumulative", stats.by_day, stats.by_day.map((d) => d.cumulative_wallets), "#FFD199")}
  </div>
</section>

<section style="padding-bottom: 64px;">
  <div class="wrap">
    <div class="model-table">
      <div class="model-head">
        <span class="mds-ui-mono-xs">Requests by model</span>
        <span class="mds-ui-mono-xs right">Requests</span>
        <span class="mds-ui-mono-xs right">Volume</span>
      </div>${modelRows(stats.by_model)}
    </div>
    <p class="mds-body-sm footnote">Reflects settled x402 payments only. <a href="/models">GET /models</a> for the live catalog.</p>
  </div>
</section>

<footer class="site">
  <p class="mds-body-sm">© 2026 UniRouter. All rights reserved.</p>
  <div class="foot-links">
    <a class="mds-body-sm" href="/">Overview</a>
    <a class="mds-body-sm" href="https://github.com/snubeaver/unirouter">GitHub</a>
    <a class="mds-body-sm" href="https://www.npmjs.com/package/unirouter-cli">npm · unirouter-cli</a>
  </div>
</footer>

</body>
</html>`;
}
