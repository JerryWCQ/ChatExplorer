/**
 * The only file that talks to the network.
 *
 * Runs in the extension page, not the service worker: MV3 may stop a worker
 * that is merely waiting on a slow model, and the stream has to reach the UI
 * anyway. The page can fetch a third-party host only with a host permission,
 * which `config.ts` requests for exactly the configured origin.
 */

import { buildRequest, mapEvent, mapFullResponse, type RequestInput, type StreamEvent, type Variant } from "./providers";
import { SseParser } from "./sse";
import type { AiConfig } from "./types";

export type ApiErrorKind = "auth" | "notfound" | "rate" | "server" | "network" | "bad_request" | "aborted";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number,
    readonly detail: string
  ) {
    super(detail || kind);
  }
}

function kindOf(status: number): ApiErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "notfound";
  if (status === 429) return "rate";
  if (status >= 500) return "server";
  return "bad_request";
}

/**
 * One retry, for the two known incompatibilities, and only when the error text
 * names the parameter — a guess would hide real errors behind a second failure.
 */
function retryVariant(cfg: AiConfig, status: number, body: string, tried: Variant): Variant | null {
  if (cfg.protocol !== "openai" || status !== 400) return null;
  if (!tried.maxCompletionTokens && /max_completion_tokens/i.test(body)) {
    return { ...tried, maxCompletionTokens: true };
  }
  if (!tried.noStreamOptions && /stream_options/i.test(body)) return { ...tried, noStreamOptions: true };
  return null;
}

/**
 * Send one request and feed every event to `onEvent` as it arrives. Resolves
 * when the response is complete; rejects with an `ApiError`.
 */
export async function streamChat(
  cfg: AiConfig,
  input: RequestInput,
  signal: AbortSignal,
  onEvent: (ev: StreamEvent) => void
): Promise<void> {
  let variant: Variant = {};
  for (let attempt = 0; ; attempt++) {
    const req = buildRequest(cfg, input, variant);
    let res: Response;
    try {
      res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal });
    } catch (err) {
      if (signal.aborted) throw new ApiError("aborted", 0, "");
      // A TypeError here almost always means CORS / no host permission, or an
      // unreachable host — the browser does not say which.
      throw new ApiError("network", 0, err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const next = attempt === 0 ? retryVariant(cfg, res.status, text, variant) : null;
      if (next) {
        variant = next;
        continue;
      }
      throw new ApiError(kindOf(res.status), res.status, extractMessage(text));
    }
    await readBody(cfg, res, signal, onEvent);
    return;
  }
}

function extractMessage(text: string): string {
  try {
    const p = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    const err = p.error;
    const msg = typeof err === "string" ? err : err?.message ?? p.message;
    if (msg) return String(msg).slice(0, 500);
  } catch {
    // not JSON
  }
  return text.slice(0, 500);
}

async function readBody(
  cfg: AiConfig,
  res: Response,
  signal: AbortSignal,
  onEvent: (ev: StreamEvent) => void
): Promise<void> {
  if (!res.body) {
    for (const ev of mapFullResponse(cfg.protocol, await res.json())) onEvent(ev);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sse = new SseParser();
  // Decided on the first bytes, not the content-type: relays mislabel both
  // ways, and some ignore `stream: true` and answer with one JSON object.
  let mode: "unknown" | "sse" | "json" = "unknown";
  let json = "";

  const emit = (events: { data: string }[]) => {
    for (const e of events) for (const ev of mapEvent(cfg.protocol, e.data)) onEvent(ev);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (mode === "unknown") {
        const head = (json + chunk).trimStart();
        if (!head) {
          json += chunk;
          continue;
        }
        mode = head.startsWith("{") ? "json" : "sse";
        if (mode === "sse") {
          emit(sse.push(json + chunk));
          json = "";
          continue;
        }
      }
      if (mode === "json") json += chunk;
      else emit(sse.push(chunk));
    }
  } catch (err) {
    if (signal.aborted) throw new ApiError("aborted", 0, "");
    throw new ApiError("network", 0, err instanceof Error ? err.message : String(err));
  }
  const tail = decoder.decode();
  if (mode === "json") {
    json += tail;
    let body: unknown;
    try {
      body = JSON.parse(json);
    } catch {
      throw new ApiError("bad_request", res.status, json.slice(0, 500));
    }
    for (const ev of mapFullResponse(cfg.protocol, body)) onEvent(ev);
  } else {
    if (tail) emit(sse.push(tail));
    emit(sse.end());
  }
}

/**
 * The settings panel's 测试连接: the smallest real request there is, through
 * the same streaming path a session uses. A few tokens, and it proves the URL,
 * the key, the model name and the permission all at once.
 */
export async function testConnection(cfg: AiConfig, signal: AbortSignal): Promise<{ text: string; ms: number }> {
  const started = performance.now();
  let text = "";
  let error: string | null = null;
  await streamChat(
    { ...cfg },
    {
      system: "Reply with the single word OK.",
      messages: [{ role: "user", parts: [{ type: "text", text: "ping" }] }],
      tools: [],
      maxTokens: 16
    },
    signal,
    (ev) => {
      if (ev.type === "text") text += ev.delta;
      if (ev.type === "error") error = ev.message;
    }
  );
  if (error) throw new ApiError("bad_request", 200, error);
  return { text: text.trim(), ms: Math.round(performance.now() - started) };
}
