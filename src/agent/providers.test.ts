/**
 * Wire formats, both directions. The stream fixtures follow the documented
 * shapes of each API, and are fed in deliberately awkward pieces — split
 * mid-line, mid-JSON, with CRLF — because that is what relays actually do.
 */

import { expect, test } from "vitest";
import { buildMessages } from "./context";
import { Assembler, buildRequest, endpointUrl, mapEvent, mapFullResponse } from "./providers";
import { SseParser } from "./sse";
import { TOOL_SPECS } from "./tools";
import { DEFAULT_AI_CONFIG, type AiConfig, type ToolBlock, type Turn } from "./types";

const anthropic: AiConfig = { ...DEFAULT_AI_CONFIG, protocol: "anthropic", apiKey: "k", model: "claude-x" };
const openai: AiConfig = { ...DEFAULT_AI_CONFIG, protocol: "openai", apiKey: "k", model: "gpt-x" };

function run(cfg: AiConfig, stream: string, pieces = 7): Assembler {
  const sse = new SseParser();
  const asm = new Assembler();
  const size = Math.ceil(stream.length / pieces);
  for (let i = 0; i < stream.length; i += size) {
    for (const e of sse.push(stream.slice(i, i + size))) for (const ev of mapEvent(cfg.protocol, e.data)) asm.apply(ev);
  }
  for (const e of sse.end()) for (const ev of mapEvent(cfg.protocol, e.data)) asm.apply(ev);
  asm.finish();
  return asm;
}

const sse = (events: [string, unknown][], crlf = false) =>
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("").replace(/\n/g, crlf ? "\r\n" : "\n");

test("endpoint URLs come out right whatever the user pasted", () => {
  expect(endpointUrl({ protocol: "anthropic", baseUrl: "" })).toBe("https://api.anthropic.com/v1/messages");
  expect(endpointUrl({ protocol: "anthropic", baseUrl: "https://relay.cc/" })).toBe("https://relay.cc/v1/messages");
  expect(endpointUrl({ protocol: "anthropic", baseUrl: "https://relay.cc/api/v1" })).toBe("https://relay.cc/api/v1/messages");
  expect(endpointUrl({ protocol: "openai", baseUrl: "" })).toBe("https://api.openai.com/v1/chat/completions");
  expect(endpointUrl({ protocol: "openai", baseUrl: "https://openrouter.ai/api/v1" })).toBe(
    "https://openrouter.ai/api/v1/chat/completions"
  );
  expect(endpointUrl({ protocol: "openai", baseUrl: "https://x.cn/v1/chat/completions" })).toBe(
    "https://x.cn/v1/chat/completions"
  );
  expect(endpointUrl({ protocol: "openai", baseUrl: "https://x.cn" })).toBe("https://x.cn/v1/chat/completions");
});

test("Anthropic stream: text, then a tool call whose JSON arrives in pieces", () => {
  const stream = sse(
    [
      ["message_start", { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 1 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "look." } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "list_chats", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"lim' } }],
      ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'it": 50}' } }],
      ["content_block_stop", { type: "content_block_stop", index: 1 }],
      ["ping", { type: "ping" }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } }],
      ["message_stop", { type: "message_stop" }]
    ],
    true
  );
  const asm = run(anthropic, stream, 13);
  expect(asm.blocks[0]).toEqual({ type: "text", text: "Let me look." });
  expect(asm.blocks[1]).toMatchObject({ type: "tool", id: "toolu_1", name: "list_chats", input: { limit: 50 } });
  expect(asm.stop).toBe("tool_use");
  // Cached input counts: the user pays for it.
  expect(asm.usage).toEqual({ input: 1000, output: 42 });
});

test("OpenAI stream: parallel tool calls keyed by index, usage in the last chunk", () => {
  const chunk = (delta: unknown, finish: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const stream =
    chunk({ role: "assistant", content: "Reading." }) +
    chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "get_overview", arguments: "" } }] }) +
    chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "search_chats", arguments: '{"que' } }] }) +
    chunk({ tool_calls: [{ index: 1, function: { arguments: 'ry":"tax"}' } }] }) +
    chunk({}, "tool_calls") +
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 30 } })}\n\n` +
    "data: [DONE]\n\n";
  const asm = run(openai, stream, 11);
  expect(asm.blocks.map((b) => b.type)).toEqual(["text", "tool", "tool"]);
  expect(asm.blocks[1]).toMatchObject({ id: "call_a", name: "get_overview", input: {} });
  expect(asm.blocks[2]).toMatchObject({ id: "call_b", name: "search_chats", input: { query: "tax" } });
  expect(asm.stop).toBe("tool_use");
  expect(asm.usage).toEqual({ input: 500, output: 30 });
});

test("a tool call cut off by max_tokens keeps input null instead of guessing", () => {
  const stream = sse([
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "apply_changes" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"summary":"x","actions":[{"ty' } }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens" } }]
  ]);
  const asm = run(anthropic, stream);
  expect((asm.blocks[0] as ToolBlock).input).toBeNull();
  expect(asm.stop).toBe("max_tokens");
});

test("an error event mid-stream surfaces as an error, not as silence", () => {
  const stream = sse([["error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]]);
  expect(run(anthropic, stream).error).toBe("Overloaded");
  expect(run(openai, `data: ${JSON.stringify({ error: { message: "quota" } })}\n\n`).error).toBe("quota");
});

test("a relay that ignores stream:true still works through the full-body mapping", () => {
  const asm = new Assembler();
  for (const ev of mapFullResponse("anthropic", {
    content: [{ type: "text", text: "OK" }, { type: "tool_use", id: "t1", name: "get_overview", input: {} }],
    stop_reason: "tool_use",
    usage: { input_tokens: 5, output_tokens: 2 }
  })) {
    asm.apply(ev);
  }
  asm.finish();
  expect(asm.blocks).toMatchObject([{ type: "text", text: "OK" }, { type: "tool", id: "t1", input: {} }]);

  const oa = new Assembler();
  for (const ev of mapFullResponse("openai", {
    choices: [{ message: { content: "hi", tool_calls: [{ id: "c", function: { name: "read_chats", arguments: '{"ids":["c1"]}' } }] }, finish_reason: "tool_calls" }]
  })) {
    oa.apply(ev);
  }
  oa.finish();
  expect(oa.blocks[1]).toMatchObject({ name: "read_chats", input: { ids: ["c1"] } });
});

// --- requests -----------------------------------------------------------------

const turns: Turn[] = [
  { sessionId: "s", idx: 0, role: "user", blocks: [{ type: "text", text: "tidy" }], ts: 0 },
  {
    sessionId: "s",
    idx: 1,
    role: "assistant",
    ts: 0,
    blocks: [
      { type: "text", text: "Looking." },
      { type: "tool", id: "t1", name: "get_overview", rawInput: "{}", input: {}, status: "done", output: "TREE" }
    ]
  }
];

test("Anthropic request: tool_use in the assistant turn, tool_result in the next user turn", () => {
  const req = buildRequest(anthropic, { system: "S", messages: buildMessages(turns), tools: TOOL_SPECS, maxTokens: 100 });
  expect(req.url).toBe("https://api.anthropic.com/v1/messages");
  expect(req.headers["x-api-key"]).toBe("k");
  const body = req.body as { messages: { role: string; content: { type: string }[] }[]; tools: unknown[]; system: unknown };
  expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(body.messages[1]!.content.map((c) => c.type)).toEqual(["text", "tool_use"]);
  expect(body.messages[2]!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: "TREE" });
  // Official host: cache breakpoints on the system prompt and the newest block.
  expect(body.system).toEqual([{ type: "text", text: "S", cache_control: { type: "ephemeral" } }]);
  expect(body.messages[2]!.content[0]).toHaveProperty("cache_control");
  expect(body.tools).toHaveLength(TOOL_SPECS.length);
});

test("Anthropic via a relay: no cache markers, and Bearer auth when asked", () => {
  const cfg: AiConfig = { ...anthropic, baseUrl: "https://relay.cc", authStyle: "bearer" };
  const req = buildRequest(cfg, { system: "S", messages: buildMessages(turns), tools: [], maxTokens: 100 });
  expect(req.headers.Authorization).toBe("Bearer k");
  expect(req.headers["x-api-key"]).toBeUndefined();
  expect(JSON.stringify(req.body)).not.toContain("cache_control");
});

test("OpenAI request: system message first, tool results as role:tool", () => {
  const req = buildRequest(openai, { system: "S", messages: buildMessages(turns), tools: TOOL_SPECS, maxTokens: 100 });
  expect(req.headers.Authorization).toBe("Bearer k");
  const body = req.body as { messages: Record<string, unknown>[]; tools: { type: string }[]; max_tokens?: number };
  expect(body.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  expect(body.messages[2]).toMatchObject({
    content: "Looking.",
    tool_calls: [{ id: "t1", type: "function", function: { name: "get_overview", arguments: "{}" } }]
  });
  expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "TREE" });
  expect(body.tools[0]!.type).toBe("function");
  expect(body.max_tokens).toBe(100);

  const retry = buildRequest(openai, { system: "S", messages: [], tools: [], maxTokens: 100 }, {
    maxCompletionTokens: true,
    noStreamOptions: true
  }).body;
  expect(retry).toMatchObject({ max_completion_tokens: 100 });
  expect(retry).not.toHaveProperty("max_tokens");
  expect(retry).not.toHaveProperty("stream_options");
});
