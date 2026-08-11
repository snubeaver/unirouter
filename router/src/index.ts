try {
  process.loadEnvFile(".env");
} catch {
  // no .env file present — fine if keys are already in the environment
}

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { buildModelsResponse } from "./models.js";
import { LOCAL_MODEL, UPSTREAMS, isUpstreamEnabled } from "./config.js";
import { callAnthropic, translateAnthropicResponse, translateAnthropicStream } from "./providers/anthropic.js";
import { checkRateLimit } from "./rate-limit.js";
import { localModelPaymentMiddleware } from "./payment.js";

const app = new Hono();

app.get("/models", async (c) => {
  const body = await buildModelsResponse();
  return c.json(body);
});

async function isLocalHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_MODEL.base_url}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function proxyHeaders(upstream: Response): HeadersInit {
  return { "Content-Type": upstream.headers.get("content-type") ?? "application/json" };
}

async function proxyToLocal(body: unknown): Promise<Response> {
  if (!(await isLocalHealthy())) {
    return new Response(JSON.stringify({ error: { message: "local model unavailable" } }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  const upstream = await fetch(`${LOCAL_MODEL.base_url}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return new Response(upstream.body, { status: upstream.status, headers: proxyHeaders(upstream) });
}

// Payment-gated entry point: flat per-request USDC-on-Monad charge, always
// serves the local model regardless of what `model` the caller passes —
// this route's entire purpose is "pay for our own hardware," not routing.
app.post("/paid/chat/completions", localModelPaymentMiddleware(), async (c) => {
  const body = await c.req.json();
  return proxyToLocal({ ...body, model: LOCAL_MODEL.id });
});

app.post("/v1/chat/completions", async (c) => {
  const body = await c.req.json();
  const modelId = body.model;

  if (modelId === LOCAL_MODEL.id) {
    return proxyToLocal(body);
  }

  const entry = UPSTREAMS.find((u) => u.id === modelId);
  if (!entry) {
    return c.json({ error: { message: `unknown model: ${modelId}` } }, 404);
  }
  if (!isUpstreamEnabled(entry)) {
    return c.json({ error: { message: `model ${modelId} not configured (missing ${entry.kill_switch})` } }, 503);
  }
  if (!checkRateLimit(entry.shared_rate_limit_key ?? entry.id, entry.rate_limit_rpm)) {
    return c.json({ error: { message: "rate limit exceeded" } }, 429);
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
    return c.json({ error: { message: errText } }, upstream.status as any);
  }
  if (body.stream) {
    return translateAnthropicStream(upstream, modelId);
  }
  return c.json(await translateAnthropicResponse(upstream, modelId));
});

const port = 3402;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`router listening on http://localhost:${info.port}`);
});
