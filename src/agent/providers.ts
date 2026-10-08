/**
 * The two wire formats, both ways: our neutral messages → a request body, and
 * the streamed response → neutral events.
 *
 * Anthropic (`/v1/messages`) is the official API. OpenAI-compatible
 * (`/chat/completions`) is what most relays (中转站) speak, including relays
 * whose model is Claude. They differ in every detail that matters here — where
 * the system prompt goes, how a tool call and its result are shaped, how a tool
 * call's arguments arrive in pieces, where usage is reported — so each gets its
 * own builder and its own event mapper, and nothing above this file knows
 * which one is in use.
 *
 * Pure: no fetch. `client.ts` does the I/O.
 */

import type { NMessage } from "./context";
import type { ToolSpec } from "./tools";
import type { AiConfig, Block, ToolBlock, Usage } from "./types";

// --- endpoint ------------------------------------------------------------------------

export const DEFAULT_BASE: Record<AiConfig["protocol"], string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1"
};

/**
 * The URL a request goes to, from whatever the user typed. People paste a bare
 * host, a host plus `/v1`, or the full endpoint; relays add their own prefix
 * (`/api/v1`, `/openai/v1`). All of those should just work, and the settings
 * panel shows the result so the rare case that does not can be fixed by eye.
 */
export function endpointUrl(cfg: Pick<AiConfig, "protocol" | "baseUrl">): string {
  const base = (cfg.baseUrl.trim() || DEFAULT_BASE[cfg.protocol]).replace(/\/+$/, "");
  if (cfg.protocol === "anthropic") {
    if (/\/messages$/.test(base)) return base;
    if (/\/v\d+$/.test(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+[a-z]*$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** Only the official host is known to accept prompt-caching markers. */
function isOfficialAnthropic(url: string): boolean {
  try {
    return new URL(url).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

// --- requests ------------------------------------------------------------------------

/**
 * Knobs for the one retry `client.ts` may make. Some OpenAI-format backends
 * reject `max_tokens` in favour of `max_completion_tokens`, and some relays
 * reject `stream_options`; the retry flips exactly the knob the error named.
 */
export interface Variant {
  maxCompletionTokens?: boolean;
  noStreamOptions?: boolean;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface RequestInput {
  system: string;
  messages: NMessage[];
  tools: ToolSpec[];
  maxTokens: number;
}

function authHeader(cfg: AiConfig): Record<string, string> {
  const style = cfg.authStyle === "auto" ? (cfg.protocol === "anthropic" ? "x-api-key" : "bearer") : cfg.authStyle;
  return style === "x-api-key" ? { "x-api-key": cfg.apiKey } : { Authorization: `Bearer ${cfg.apiKey}` };
}

export function buildRequest(cfg: AiConfig, input: RequestInput, variant: Variant = {}): BuiltRequest {
  const url = endpointUrl(cfg);
  if (cfg.protocol === "anthropic") return buildAnthropic(cfg, url, input);
  return buildOpenAI(cfg, url, input, variant);
}

function buildAnthropic(cfg: AiConfig, url: string, input: RequestInput): BuiltRequest {
  const cache = isOfficialAnthropic(url);
  const messages = input.messages.map((m) => ({
    role: m.role,
    content: m.parts.map((p): Record<string, unknown> => {
      if (p.type === "text") return { type: "text", text: p.text };
      if (p.type === "tool_call") return { type: "tool_use", id: p.id, name: p.name, input: p.input };
      return { type: "tool_result", tool_use_id: p.id, content: p.content };
    })
  }));
  // Caching the prefix is what makes a long tool loop affordable: every round
  // resends the whole conversation, and a cached prefix is billed at a tenth.
  // Breakpoints on the system prompt and on the newest message.
  const lastContent = messages.at(-1)?.content;
  const lastPart = lastContent?.at(-1);
  if (cache && lastPart) lastPart.cache_control = { type: "ephemeral" };

  const tools = input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  return {
    url,
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      // Needed for the official API from a browser context; harmless elsewhere.
      "anthropic-dangerous-direct-browser-access": "true",
      ...authHeader(cfg)
    },
    body: {
      model: cfg.model,
      max_tokens: input.maxTokens,
      stream: true,
      system: cache ? [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }] : input.system,
      messages,
      ...(tools.length ? { tools } : {})
    }
  };
}

function buildOpenAI(cfg: AiConfig, url: string, input: RequestInput, variant: Variant): BuiltRequest {
  const messages: Record<string, unknown>[] = [{ role: "system", content: input.system }];
  for (const m of input.messages) {
    if (m.role === "user") {
      // Tool results are messages of their own here, and must come straight
      // after the assistant message that asked for them.
      for (const p of m.parts) {
        if (p.type === "tool_result") messages.push({ role: "tool", tool_call_id: p.id, content: p.content });
      }
      const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
      if (text) messages.push({ role: "user", content: text });
      continue;
    }
    const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
    const calls = m.parts.flatMap((p) =>
      p.type === "tool_call"
        ? [{ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input) } }]
        : []
    );
    messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
  }
  const tools = input.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }));
  return {
    url,
    headers: { "content-type": "application/json", ...authHeader(cfg) },
    body: {
      model: cfg.model,
      stream: true,
      ...(variant.noStreamOptions ? {} : { stream_options: { include_usage: true } }),
      ...(variant.maxCompletionTokens ? { max_completion_tokens: input.maxTokens } : { max_tokens: input.maxTokens }),
      messages,
      ...(tools.length ? { tools } : {})
    }
  };
}

// --- responses -----------------------------------------------------------------------

export type StopReason = "end" | "tool_use" | "max_tokens" | "other";

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; key: string; id: string; name: string }
  | { type: "tool_args"; key: string; delta: string }
  | { type: "usage"; input?: number; output?: number }
  | { type: "stop"; reason: StopReason }
  | { type: "error"; message: string };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function errorMessage(payload: Record<string, unknown>): string {
  const err = obj(payload.error);
  return String(err.message ?? payload.message ?? JSON.stringify(payload.error ?? payload));
}

let generated = 0;
/** Some OpenAI-format backends omit tool-call ids; both APIs need one to pair the result. */
const freshId = () => `call_${Date.now().toString(36)}_${(generated++).toString(36)}`;

/** One SSE `data` payload → events. Stateless per payload by design. */
export function mapEvent(protocol: AiConfig["protocol"], data: string): StreamEvent[] {
  if (data === "[DONE]") return [];
  let payload: Record<string, unknown>;
  try {
    payload = obj(JSON.parse(data));
  } catch {
    return [];
  }
  return protocol === "anthropic" ? mapAnthropic(payload) : mapOpenAI(payload);
}

function mapAnthropic(p: Record<string, unknown>): StreamEvent[] {
  switch (p.type) {
    case "message_start": {
      const usage = obj(obj(p.message).usage);
      // Cached tokens are reported apart from the rest; the user pays for all of them.
      const input =
        (num(usage.input_tokens) ?? 0) +
        (num(usage.cache_creation_input_tokens) ?? 0) +
        (num(usage.cache_read_input_tokens) ?? 0);
      return [{ type: "usage", input, output: num(usage.output_tokens) }];
    }
    case "content_block_start": {
      const block = obj(p.content_block);
      const key = String(p.index ?? 0);
      if (block.type === "tool_use") {
        return [{ type: "tool_start", key, id: String(block.id ?? freshId()), name: String(block.name ?? "") }];
      }
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        return [{ type: "text", delta: block.text }];
      }
      return [];
    }
    case "content_block_delta": {
      const delta = obj(p.delta);
      const key = String(p.index ?? 0);
      if (delta.type === "text_delta" && typeof delta.text === "string") return [{ type: "text", delta: delta.text }];
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        return [{ type: "tool_args", key, delta: delta.partial_json }];
      }
      return [];
    }
    case "message_delta": {
      const out: StreamEvent[] = [];
      const usage = obj(p.usage);
      if (num(usage.output_tokens) !== undefined) out.push({ type: "usage", output: num(usage.output_tokens) });
      const reason = obj(p.delta).stop_reason;
      if (typeof reason === "string") out.push({ type: "stop", reason: anthropicStop(reason) });
      return out;
    }
    case "error":
      return [{ type: "error", message: errorMessage(p) }];
    default:
      return [];
  }
}

function anthropicStop(reason: string): StopReason {
  if (reason === "end_turn" || reason === "stop_sequence") return "end";
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "other";
}

function mapOpenAI(p: Record<string, unknown>): StreamEvent[] {
  if (p.error) return [{ type: "error", message: errorMessage(p) }];
  const out: StreamEvent[] = [];
  const choices = Array.isArray(p.choices) ? p.choices : [];
  const choice = obj(choices[0]);
  // Streaming chunks carry `delta`; a non-streamed body carries `message`.
  const delta = obj(choice.delta ?? choice.message);
  if (typeof delta.content === "string" && delta.content) out.push({ type: "text", delta: delta.content });
  const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
  calls.forEach((raw, position) => {
    const call = obj(raw);
    const fn = obj(call.function);
    const key = String(call.index ?? position);
    if (call.id || fn.name) {
      out.push({ type: "tool_start", key, id: String(call.id ?? freshId()), name: String(fn.name ?? "") });
    }
    if (typeof fn.arguments === "string" && fn.arguments) out.push({ type: "tool_args", key, delta: fn.arguments });
    // A non-streamed body may already hold parsed arguments.
    else if (fn.arguments && typeof fn.arguments === "object") {
      out.push({ type: "tool_args", key, delta: JSON.stringify(fn.arguments) });
    }
  });
  const usage = obj(p.usage);
  if (num(usage.prompt_tokens) !== undefined || num(usage.completion_tokens) !== undefined) {
    out.push({ type: "usage", input: num(usage.prompt_tokens), output: num(usage.completion_tokens) });
  }
  if (typeof choice.finish_reason === "string") {
    const r = choice.finish_reason;
    out.push({
      type: "stop",
      reason: r === "stop" ? "end" : r === "tool_calls" || r === "function_call" ? "tool_use" : r === "length" ? "max_tokens" : "other"
    });
  }
  return out;
}

/**
 * A whole non-streamed response body → the same events. Some relays ignore
 * `stream: true` and answer with plain JSON; handling that here means the rest
 * of the loop never finds out.
 */
export function mapFullResponse(protocol: AiConfig["protocol"], body: unknown): StreamEvent[] {
  const p = obj(body);
  if (p.error || p.type === "error") return [{ type: "error", message: errorMessage(p) }];
  if (protocol === "openai") return mapOpenAI(p);

  const out: StreamEvent[] = [];
  const usage = obj(p.usage);
  out.push({
    type: "usage",
    input: (num(usage.input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0),
    output: num(usage.output_tokens)
  });
  const content = Array.isArray(p.content) ? p.content : [];
  content.forEach((raw, i) => {
    const b = obj(raw);
    if (b.type === "text" && typeof b.text === "string") out.push({ type: "text", delta: b.text });
    if (b.type === "tool_use") {
      out.push({ type: "tool_start", key: String(i), id: String(b.id ?? freshId()), name: String(b.name ?? "") });
      out.push({ type: "tool_args", key: String(i), delta: JSON.stringify(b.input ?? {}) });
    }
  });
  if (typeof p.stop_reason === "string") out.push({ type: "stop", reason: anthropicStop(p.stop_reason) });
  return out;
}

// --- assembling ----------------------------------------------------------------------

/**
 * Events → the blocks of one assistant turn. Lives here rather than in the loop
 * so the streaming UI and the tests build turns the same way.
 */
export class Assembler {
  readonly blocks: Block[] = [];
  readonly usage: Usage = { input: 0, output: 0 };
  stop: StopReason | null = null;
  error: string | null = null;
  private tools = new Map<string, ToolBlock>();

  apply(ev: StreamEvent): void {
    switch (ev.type) {
      case "text": {
        const last = this.blocks.at(-1);
        if (last?.type === "text") last.text += ev.delta;
        else this.blocks.push({ type: "text", text: ev.delta });
        return;
      }
      case "tool_start": {
        // Some backends repeat the id on every chunk of the same call.
        if (this.tools.has(ev.key)) return;
        const block: ToolBlock = { type: "tool", id: ev.id, name: ev.name, rawInput: "", input: null, status: "running" };
        this.tools.set(ev.key, block);
        this.blocks.push(block);
        return;
      }
      case "tool_args": {
        let block = this.tools.get(ev.key);
        if (!block) {
          // Arguments before any start: an id-less backend. Open the call now.
          block = { type: "tool", id: freshId(), name: "", rawInput: "", input: null, status: "running" };
          this.tools.set(ev.key, block);
          this.blocks.push(block);
        }
        block.rawInput += ev.delta;
        return;
      }
      case "usage":
        if (ev.input !== undefined) this.usage.input = ev.input;
        if (ev.output !== undefined) this.usage.output = ev.output;
        return;
      case "stop":
        this.stop = ev.reason;
        return;
      case "error":
        this.error = ev.message;
        return;
    }
  }

  /** Parse every call's arguments. A call cut off mid-JSON keeps `input: null`. */
  finish(): void {
    for (const block of this.tools.values()) {
      const raw = block.rawInput.trim();
      if (raw === "") {
        block.input = {};
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(raw);
        block.input = obj(parsed);
      } catch {
        block.input = null;
      }
    }
  }
}
