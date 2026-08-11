// Translation layer: Anthropic's native /v1/messages API has a different
// request/response and SSE event shape than the OpenAI-compatible surface
// every other upstream (and vLLM itself) speaks. This file is the only place
// that knows about that difference.

interface OpenAIMessage {
  role: string;
  content: string;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

function toAnthropicRequest(req: OpenAIChatRequest) {
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const messages = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
  return {
    model: req.model,
    system: system || undefined,
    messages,
    max_tokens: req.max_tokens ?? 1024,
    temperature: req.temperature,
    stream: req.stream ?? false,
  };
}

export async function callAnthropic(
  baseUrl: string,
  apiKey: string,
  req: OpenAIChatRequest,
): Promise<Response> {
  return fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(toAnthropicRequest(req)),
  });
}

export async function translateAnthropicResponse(res: Response, model: string) {
  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const promptTokens = data.usage?.input_tokens ?? 0;
  const completionTokens = data.usage?.output_tokens ?? 0;
  return {
    id: `chatcmpl-${Math.random().toString(36).slice(2)}`,
    object: "chat.completion",
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: data.stop_reason ?? "stop" },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// Re-streams Anthropic's SSE events as OpenAI-compatible chat.completion.chunk
// frames, translating incrementally (not buffering the full response) so
// real TTFT is preserved.
export function translateAnthropicStream(upstream: Response, model: string): Response {
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-${Math.random().toString(36).slice(2)}`;

  let buf = "";
  let inputTokens = 0;
  let outputTokens = 0;

  // Driven from `start()`, not `pull()`: many Anthropic SSE events (message_start,
  // content_block_start, ping) carry no visible content and so trigger zero
  // `enqueue()` calls. Relying on the runtime to re-invoke `pull()` after an
  // empty return proved unreliable under @hono/node-server — pulls stopped
  // after the first event carried no enqueue. Driving the whole read loop
  // ourselves sidesteps that.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          const usageChunk = {
            id,
            object: "chat.completion.chunk",
            model,
            choices: [],
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
            },
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }

        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (!raw) continue;
          let evt: any;
          try {
            evt = JSON.parse(raw);
          } catch {
            continue;
          }
          if (evt.type === "message_start") {
            inputTokens = evt.message?.usage?.input_tokens ?? 0;
          } else if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            const chunk = {
              id,
              object: "chat.completion.chunk",
              model,
              choices: [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } else if (evt.type === "message_delta") {
            outputTokens = evt.usage?.output_tokens ?? outputTokens;
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}
