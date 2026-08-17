try {
  process.loadEnvFile(".env");
} catch {
  // no .env file present — fine if keys are already in the environment
}

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { buildModelsResponse } from "./models.js";
import {
  UNIROUTER_MODEL,
  MAX_OUTPUT_TOKENS_CEILING,
  MAX_REQUEST_BODY_BYTES,
  PREPAY_ASSUMED_PROMPT_TOKENS,
  UPSTREAMS,
  UpstreamEntry,
  clampOutputTokens,
  isUpstreamEnabled,
} from "./config.js";
import { callAnthropic, translateAnthropicResponse, translateAnthropicStream } from "./providers/anthropic.js";
import { checkRateLimit } from "./rate-limit.js";
import { PAYABLE_MODELS, paidModelsPaymentMiddleware, priceForRequest } from "./payment.js";
import { recordPayment, readStats } from "./stats.js";
import { renderDashboard } from "./dashboard.js";
import { renderLanding } from "./landing.js";

const app = new Hono();

app.use(logger());

app.onError((err, c) => {
  console.error(`[error] ${c.req.method} ${c.req.path}:`, err);
  return c.json({ error: { message: "internal error" } }, 500);
});

async function readJsonBody(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

app.get("/models", async (c) => {
  const body = await buildModelsResponse();
  return c.json(body);
});

app.get("/", (c) => c.html(renderLanding(readStats())));
app.get("/dashboard", (c) => c.html(renderDashboard(readStats())));
app.use("/favicon.svg", serveStatic({ path: "./public/favicon.svg" }));

async function isUniRouterModelHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${UNIROUTER_MODEL.base_url}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function proxyHeaders(upstream: Response): HeadersInit {
  return { "Content-Type": upstream.headers.get("content-type") ?? "application/json" };
}

async function proxyToUniRouterModel(body: unknown): Promise<Response> {
  if (!(await isUniRouterModelHealthy())) {
    return new Response(JSON.stringify({ error: { message: `${UNIROUTER_MODEL.id} is temporarily unavailable` } }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  const upstream = await fetch(`${UNIROUTER_MODEL.base_url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(upstream.body, { status: upstream.status, headers: proxyHeaders(upstream) });
}

async function proxyToUpstream(entry: UpstreamEntry, body: any): Promise<Response> {
  if (!isUpstreamEnabled(entry)) {
    return new Response(
      JSON.stringify({ error: { message: `model ${entry.id} not configured (missing ${entry.kill_switch})` } }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!checkRateLimit(entry.shared_rate_limit_key ?? entry.id, entry.rate_limit_rpm)) {
    return new Response(JSON.stringify({ error: { message: "rate limit exceeded" } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = process.env[entry.kill_switch]!;

  if (entry.provider === "openai-compatible") {
    const outBody = { ...body, model: entry.upstream_model_id ?? entry.id };
    if (entry.rename_max_tokens_to_completion && outBody.max_tokens !== undefined && outBody.max_completion_tokens === undefined) {
      outBody.max_completion_tokens = outBody.max_tokens;
      delete outBody.max_tokens;
    }
    const upstream = await fetch(`${entry.base_url}${entry.completions_path ?? "/v1/chat/completions"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(outBody),
    });
    return new Response(upstream.body, { status: upstream.status, headers: proxyHeaders(upstream) });
  }

  // anthropic-native
  const upstream = await callAnthropic(entry.base_url, apiKey, body);
  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(JSON.stringify({ error: { message: errText } }), {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (body.stream) {
    return translateAnthropicStream(upstream, entry.id);
  }
  return new Response(JSON.stringify(await translateAnthropicResponse(upstream, entry.id)), {
    headers: { "Content-Type": "application/json" },
  });
}

// Request-size guard. Must run BEFORE the payment middleware so an
// oversized request is rejected before any payment is authorized, not
// after. The price covers PREPAY_ASSUMED_PROMPT_TOKENS of input (enforced
// as a body-size limit at ~4 bytes/token) and the output budget bought
// via the X-Max-Tokens header (default 1000) — the body's max_tokens may
// not exceed what was paid for.
app.use("/paid/:slug/chat/completions", async (c, next) => {
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_REQUEST_BODY_BYTES) {
    return c.json(
      {
        error: {
          message: `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes (~${PREPAY_ASSUMED_PROMPT_TOKENS} input tokens) — the per-request price covers up to that much input`,
        },
      },
      400,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return c.json({ error: { message: "request body must be a JSON object" } }, 400);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return c.json({ error: { message: "request body must be a JSON object" } }, 400);
  }
  const header = c.req.header("x-max-tokens");
  if (header !== undefined && (!Number.isFinite(Number(header)) || Number(header) < 1 || Number(header) > MAX_OUTPUT_TOKENS_CEILING)) {
    return c.json(
      { error: { message: `X-Max-Tokens must be a number between 1 and ${MAX_OUTPUT_TOKENS_CEILING}` } },
      400,
    );
  }
  const paidOutputBudget = clampOutputTokens(header);
  const body = parsed as Record<string, unknown>;
  for (const field of ["max_tokens", "max_completion_tokens"]) {
    const v = body[field];
    if (v !== undefined && Number(v) > paidOutputBudget) {
      return c.json(
        {
          error: {
            message: `${field} exceeds the paid output budget of ${paidOutputBudget} — request a larger budget via the X-Max-Tokens header (priced accordingly)`,
          },
        },
        400,
      );
    }
  }
  await next();
});

// Records a settled payment once the payment middleware (registered next)
// and the route handler below it have both run — Hono's middleware stack
// unwinds in reverse, so `c.res` here already carries the
// `payment-response` header the payment middleware attaches on success.
app.use("/paid/:slug/chat/completions", async (c, next) => {
  await next();
  const paymentResponse = c.res.headers.get("payment-response");
  if (!paymentResponse) return;
  try {
    const decoded = JSON.parse(Buffer.from(paymentResponse, "base64").toString("utf8"));
    if (!decoded.success) return;
    const model = PAYABLE_MODELS.find((m) => m.slug === c.req.param("slug"));
    if (!model) return;
    const amount = Number(priceForRequest(model, c.req.header("x-max-tokens")).toFixed(6));
    recordPayment({ ts: new Date().toISOString(), model: model.id, payer: decoded.payer, amount_usd: amount, tx: decoded.transaction });
  } catch {
    // malformed header shouldn't take down the response that already succeeded
  }
});

// Payment-gated entry point: every paid model (UniRouter's own serving
// node and every paid upstream) has its own flat-priced route by slug.
// See payment.ts for price derivation.
app.use("/paid/*", paidModelsPaymentMiddleware());
app.post("/paid/:slug/chat/completions", async (c) => {
  const slug = c.req.param("slug");
  const model = PAYABLE_MODELS.find((m) => m.slug === slug);
  if (!model) {
    return c.json({ error: { message: `unknown or unpayable model slug: ${slug}` } }, 404);
  }
  const body = await readJsonBody(c);
  if (!body) {
    return c.json({ error: { message: "request body must be a JSON object" } }, 400);
  }
  if (body.max_tokens === undefined && body.max_completion_tokens === undefined) {
    body.max_tokens = clampOutputTokens(c.req.header("x-max-tokens"));
  }
  if (!model.entry) {
    return proxyToUniRouterModel({ ...body, model: UNIROUTER_MODEL.id });
  }
  return proxyToUpstream(model.entry, { ...body, model: model.id });
});

// Open, unauthenticated route — deliberately restricted to `beta-free`
// models only. There's no real cost to protect on those, so payment
// friction would be pointless; everything else (UniRouter's own serving
// node, every paid upstream) must go through /paid/<slug>/chat/completions.
app.post("/v1/chat/completions", async (c) => {
  const body = await readJsonBody(c);
  if (!body) {
    return c.json({ error: { message: "request body must be a JSON object" } }, 400);
  }
  const modelId = body.model;

  const payable = PAYABLE_MODELS.find((m) => m.id === modelId);
  if (payable) {
    return c.json(
      { error: { message: `${modelId} requires payment — use POST /paid/${payable.slug}/chat/completions` } },
      402,
    );
  }

  const entry = UPSTREAMS.find((u) => u.id === modelId);
  if (!entry) {
    return c.json({ error: { message: `unknown model: ${modelId}` } }, 404);
  }

  return proxyToUpstream(entry, body);
});

const port = 3402;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`router listening on http://localhost:${info.port}`);
});
