/**
 * Shared shapes for the AI organizer.
 *
 * The organizer is an agent loop: the model reads the local index through
 * tools, proposes changes through one write tool, and every accepted batch of
 * changes becomes one step of the app's undo log. The conversation is stored in
 * our own provider-neutral form (below) and translated to whichever wire format
 * the user's endpoint speaks only at send time — which is what lets one session
 * survive a switch between the official API and a relay.
 */

import type { MessageKey, Vars } from "../ui/i18n";

// --- connection ------------------------------------------------------------------

/**
 * The two wire formats in the wild. Relays (中转站) mostly speak the OpenAI one
 * even when the model behind them is Claude; the official API speaks its own.
 */
export type Protocol = "anthropic" | "openai";

/**
 * `auto` = what the protocol expects (x-api-key for Anthropic, Bearer for
 * OpenAI). The override exists because some Anthropic-format relays want a
 * Bearer token instead.
 */
export type AuthStyle = "auto" | "x-api-key" | "bearer";

export interface AiConfig {
  protocol: Protocol;
  /** As typed by the user; `endpointUrl` turns it into the real URL. */
  baseUrl: string;
  apiKey: string;
  model: string;
  authStyle: AuthStyle;
  /** Per response. */
  maxTokens: number;
  /** Model round-trips allowed per user message before the loop stops itself. */
  maxRounds: number;
  /**
   * true = batches apply as soon as the model proposes them (rewind is the
   * safety net); false = every batch waits for 执行 / 拒绝. Deletions always
   * wait, whatever this says — deleting requires a confirmation in this app.
   */
  autoApply: boolean;
  /**
   * The user's standing organizing preferences, free text, sent with every
   * session (「整理偏好」). Edited in Settings, and grown by the agent through
   * `remember_preference` — each addition confirmed by the user.
   */
  preferences: string;
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  protocol: "anthropic",
  baseUrl: "",
  apiKey: "",
  model: "",
  authStyle: "auto",
  maxTokens: 8192,
  maxRounds: 40,
  autoApply: true,
  preferences: ""
};

// --- scope -----------------------------------------------------------------------

/**
 * What the user right-clicked on. Blank space means everything; otherwise the
 * selected folders (whole subtrees) and loose chats. See `scope.ts` for what
 * each shape is allowed to read and write.
 */
export type AgentScope =
  | { kind: "all" }
  | { kind: "items"; folderIds: string[]; chatUuids: string[] };

// --- conversation ----------------------------------------------------------------

/** A line of UI text that stays translatable after it has been persisted. */
export interface Line {
  key: MessageKey;
  vars?: Vars;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export type ToolStatus = "running" | "awaiting" | "done" | "error" | "rejected";

/**
 * One tool call and its result, kept together.
 *
 * The wire formats split these across two messages (tool_use in the
 * assistant's, tool_result in the next user one). Keeping them in one block is
 * what makes the UI's expandable tool rows trivial and a rewind "to before this
 * call" a plain truncation; the split is redone at send time.
 */
export interface ToolBlock {
  type: "tool";
  /** The provider's call id — required to pair the result on the wire. */
  id: string;
  name: string;
  /** Arguments exactly as streamed; kept even when they fail to parse. */
  rawInput: string;
  input: Record<string, unknown> | null;
  status: ToolStatus;
  /** What goes back to the model. */
  output?: string;
  /** One line for the collapsed row. */
  brief?: Line;
  /** Read tools: the result in one English line, sent instead once it is old. */
  digest?: string;
  /** Write tool: what the batch does, one line per change. */
  preview?: Line[];
  /** Write tool: actions that were refused, one line each. */
  errors?: Line[];
  /** Write tool: the undo step this batch became. The rewind anchor. */
  seq?: number;
}

export type Block = TextBlock | ToolBlock;

export type StopKind = "end" | "max_tokens" | "aborted" | "error" | "round_limit";

export interface Turn {
  sessionId: string;
  idx: number;
  role: "user" | "assistant";
  blocks: Block[];
  ts: number;
  /** Assistant turns: tokens this one response cost. */
  usage?: Usage;
  /** Assistant turns that did not end normally. */
  stop?: StopKind;
  /** With stop "error": which kind (auth, network, …) and the server's words. */
  errorKind?: string;
  error?: string;
}

export interface Usage {
  input: number;
  output: number;
}

export interface Session {
  id: string;
  /** The first user message, trimmed — what the session list shows. */
  title: string;
  scope: AgentScope;
  createdAt: number;
  updatedAt: number;
  /** Short-id registry; see `ids.ts`. Persisted so old references stay valid. */
  ids: { chats: string[]; folders: string[] };
  usage: Usage;
  /** Model the session last ran on, for the list. */
  model: string;
  /**
   * Every undo step this session committed. Rewind uses the union over all
   * sessions to tell the agent's steps from the user's own manual edits,
   * without reading a single turn.
   */
  steps: number[];
}
