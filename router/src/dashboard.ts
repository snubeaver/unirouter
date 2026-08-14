import type { Stats } from "./stats.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

// Requests-per-day and wallets-per-day differ by orders of magnitude
// (thousands vs. single digits) — a shared axis flattens the smaller
// series to an invisible line at the bottom, so each gets its own scale
// instead of one combined chart.
function miniLineChart(byDay: Stats["by_day"], values: number[], colorVar: string, title: string): string {
  const width = 780;
  const height = 140;
  const padLeft = 32;
  const padRight = 16;
  const padTop = 12;
  const padBottom = 24;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const maxVal = Math.max(1, ...values);
  const yTicks = 3;
  const xFor = (i: number) => padLeft + (values.length === 1 ? plotW / 2 : (i / (values.length - 1)) * plotW);
  const yFor = (v: number) => padTop + plotH - (v / maxVal) * plotH;

  const gridlines = Array.from({ length: yTicks + 1 }, (_, i) => {
    const v = Math.round((maxVal / yTicks) * i);
    const y = yFor(v);
    return `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" stroke="var(--gridline)" stroke-width="1"/>
      <text x="${padLeft - 6}" y="${y + 3}" text-anchor="end" font-size="10" fill="var(--text-muted)">${v}</text>`;
  }).join("");

  const showEvery = Math.max(1, Math.ceil(byDay.length / 10));
  const xLabels = byDay
    .map((d, i) => {
      if (i % showEvery !== 0 && i !== byDay.length - 1) return "";
      return `<text x="${xFor(i)}" y="${height - 6}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${d.date.slice(5)}</text>`;
    })
    .join("");

  const points = values.map((v, i) => `${xFor(i)},${yFor(v)}`).join(" ");
  const dots = values.map((v, i) => `<circle cx="${xFor(i)}" cy="${yFor(v)}" r="4" fill="${colorVar}"/>`).join("");

  return `
    <p class="chart-title">${escapeHtml(title)}</p>
    <svg viewBox="0 0 ${width} ${height}" class="line-chart" role="img" aria-label="${escapeHtml(title)} by day">
      ${gridlines}
      ${xLabels}
      <polyline points="${points}" fill="none" stroke="${colorVar}" stroke-width="2"/>
      ${dots}
    </svg>`;
}

function dailyCharts(byDay: Stats["by_day"]): string {
  if (byDay.length === 0) {
    return `<p class="empty">No requests yet.</p>`;
  }
  return (
    miniLineChart(byDay, byDay.map((d) => d.requests), "var(--cat-1)", "Requests per day") +
    miniLineChart(byDay, byDay.map((d) => d.unique_wallets), "var(--cat-2)", "Unique wallets per day")
  );
}

function barChart(byModel: Stats["by_model"]): string {
  if (byModel.length === 0) {
    return `<p class="empty">No requests yet.</p>`;
  }
  const max = Math.max(...byModel.map((m) => m.count));
  const rows = byModel
    .map((m) => {
      const pct = Math.max((m.count / max) * 100, 3);
      return `
        <div class="bar-row">
          <div class="bar-label">${escapeHtml(m.model)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
          <div class="bar-value">${m.count} · ${fmtUsd(m.volume_usd)}</div>
        </div>`;
    })
    .join("");
  return `<div class="bar-chart">${rows}</div>`;
}

export function renderDashboard(stats: Stats): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UniRouter — Dashboard</title>
<style>
  :root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --page: #f9f9f7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #898781;
    --gridline: #e1e0d9;
    --baseline: #c3c2b7;
    --border: rgba(11,11,11,0.10);
    --seq-500: #256abf;
    --seq-100: #cde2fb;
    --cat-1: #2a78d6;
    --cat-2: #eb6834;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --page: #0d0d0d;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --text-muted: #898781;
      --gridline: #2c2c2a;
      --baseline: #383835;
      --border: rgba(255,255,255,0.10);
      --seq-500: #3987e5;
      --seq-100: #184f95;
      --cat-1: #3987e5;
      --cat-2: #d95926;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--page);
    color: var(--text-primary);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 32px 20px 64px;
  }
  .wrap { max-width: 840px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .subtitle { color: var(--text-secondary); font-size: 14px; margin: 0 0 28px; }
  .stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 32px; }
  .stat-tile {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 18px;
  }
  .stat-label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 0 0 6px; }
  .stat-value { font-size: 28px; font-weight: 600; margin: 0; }
  .section-title { font-size: 14px; color: var(--text-secondary); margin: 0 0 12px; font-weight: 600; }
  .bar-chart { display: flex; flex-direction: column; gap: 10px; }
  .bar-row { display: grid; grid-template-columns: 180px 1fr 130px; align-items: center; gap: 12px; }
  .bar-label {
    font-size: 13px; color: var(--text-secondary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .bar-track {
    position: relative;
    height: 18px;
    background: var(--seq-100);
    border-radius: 4px;
  }
  .bar-fill {
    position: absolute; left: 0; top: 0; bottom: 0;
    background: var(--seq-500);
    border-radius: 4px;
    min-width: 4px;
  }
  .bar-value {
    font-size: 12px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .empty { color: var(--text-muted); font-size: 14px; }
  .chart-title { font-size: 12px; color: var(--text-muted); margin: 0 0 4px; }
  .line-chart { width: 100%; height: auto; margin-bottom: 20px; }
  footer { margin-top: 40px; font-size: 12px; color: var(--text-muted); }
  footer a { color: inherit; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>UniRouter</h1>
    <p class="subtitle">x402 settlement activity, live from the router's own payment log.</p>

    <div class="stat-row">
      <div class="stat-tile">
        <p class="stat-label">Total requests</p>
        <p class="stat-value">${stats.total_requests}</p>
      </div>
      <div class="stat-tile">
        <p class="stat-label">Total volume</p>
        <p class="stat-value">${fmtUsd(stats.total_volume_usd)}</p>
      </div>
      <div class="stat-tile">
        <p class="stat-label">Unique wallets</p>
        <p class="stat-value">${stats.unique_wallets}</p>
      </div>
    </div>

    <p class="section-title">Requests &amp; unique wallets by day</p>
    ${dailyCharts(stats.by_day)}

    <p class="section-title">Requests by model</p>
    ${barChart(stats.by_model)}

    <footer>
      Reflects settled x402 payments only. <a href="/models">GET /models</a> for the live catalog.
    </footer>
  </div>
</body>
</html>`;
}
