/**
 * The AI organizer's side panel.
 *
 * Docked where the preview pane sits, rather than a modal: the whole point is
 * to watch the folders change while the agent works, and a modal would cover
 * exactly that. Batches it commits briefly highlight in the grid (App does the
 * painting).
 *
 * All conversation state lives on an `AgentRunner`; this component re-reads it
 * when the runner says something changed, throttled to one render per frame so
 * a fast stream does not render per token. Nothing here re-renders App.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ensureHostPermission, isConfigured, loadAiConfig, originPattern } from "../agent/config";
import { planRewind, rewindStatus, stepState, type RewindPoint } from "../agent/rewind";
import { AgentRunner, newSession } from "../agent/runner";
import { resolveAccess, scopeChats } from "../agent/scope";
import { allAgentSteps, deleteSession, listSessions, loadTurns } from "../agent/sessions";
import { REMEMBER_TOOL, WRITE_TOOL } from "../agent/tools";
import { DEFAULT_AI_CONFIG, type AgentScope, type AiConfig, type Line, type ToolBlock, type Turn } from "../agent/types";
import { logIndex } from "../core/ops";
import type { Chat, Folder } from "../core/schema";
import { formatDate } from "../ui/format";
import { Icon } from "../ui/Icon";
import type { Lang, T } from "../ui/i18n";
import { Markdown } from "../ui/markdown";
import { apiErrorText } from "./agent-settings";
import { onDataChanged, port } from "./dataport";
import { ConfirmDialog, ContextMenu, type ConfirmSpec, type MenuEntry, type MenuSpec } from "./overlays";

export interface AgentRequest {
  scope: AgentScope;
  /** Reopen a stored session; null starts a new one on `scope`. */
  sessionId: string | null;
  /** Changes on every request, so asking twice for "new on the same scope" still resets. */
  nonce: number;
}

interface Props {
  request: AgentRequest;
  folders: Folder[];
  chats: Chat[];
  width: number;
  lang: Lang;
  t: T;
  onClose: () => void;
  onOpenSettings: () => void;
  onCommitted: (touched: string[]) => void;
  onRunningChange: (running: boolean) => void;
  onToast: (text: string) => void;
}

/** Preview lines shown before a long batch folds the rest behind "N more". */
const PLAN_LINES = 8;

const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const say = (t: T, line: Line | undefined) => (line ? t(line.key, line.vars) : "");

export function AgentPanel(props: Props) {
  const { request, folders, chats, width, lang, t, onClose, onOpenSettings, onCommitted, onRunningChange, onToast } = props;

  const [config, setConfig] = useState<AiConfig>(DEFAULT_AI_CONFIG);
  const [runner, setRunner] = useState<AgentRunner | null>(null);
  const [, setVersion] = useState(0);
  const [input, setInput] = useState("");
  const [log, setLog] = useState<{ seqs: number[]; cursor: number }>({ seqs: [], cursor: 0 });
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);
  const [menu, setMenu] = useState<MenuSpec | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const frame = useRef(0);
  const wasRunning = useRef(false);

  // One render per frame, however fast the stream.
  const bump = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setVersion((v) => v + 1);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // Config and the undo log's shape: both change through the data port.
  useEffect(() => {
    let live = true;
    const refresh = () => {
      void loadAiConfig().then((c) => live && setConfig(c));
      void logIndex().then((l) => live && setLog(l));
    };
    refresh();
    const off = onDataChanged(refresh);
    return () => {
      live = false;
      off();
    };
  }, []);

  // What to show: App's latest request, or a switch made inside the panel
  // (新对话 / a past conversation). Either way a new nonce means a new runner;
  // everything else reaches the current runner through `setDeps` below.
  const [active, setActive] = useState<AgentRequest>(request);
  // Keyed on the nonce, not the object: App may hand over an equal request
  // on every render, and that must not undo a switch made in here.
  useEffect(() => setActive(request), [request.nonce]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let session = newSession(active.scope);
      let turns: Turn[] = [];
      if (active.sessionId) {
        const found = (await listSessions()).find((s) => s.id === active.sessionId);
        if (found) {
          session = found;
          turns = await loadTurns(found.id);
        }
      }
      if (cancelled) return;
      setRunner((prev) => {
        prev?.stop();
        return new AgentRunner(session, turns, { config, lang, t, onChange: bump, onCommitted });
      });
      setNotice(null);
      stick.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [active.nonce]);

  // Leaving the panel stops a run; its state is already on disk turn by turn.
  const runnerRef = useRef(runner);
  runnerRef.current = runner;
  useEffect(() => () => runnerRef.current?.stop(), []);

  runner?.setDeps({ config, lang, t, onChange: bump, onCommitted });

  const running = runner?.running ?? false;
  useEffect(() => {
    if (wasRunning.current !== running) {
      wasRunning.current = running;
      onRunningChange(running);
    }
  });

  // Follow the stream unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const scopeLabel = useMemo(() => {
    const scope = runner?.session.scope ?? active.scope;
    const access = resolveAccess(scope, { folders, chats, shortcuts: [], stacks: [] });
    const n = scopeChats(access, { folders, chats, shortcuts: [], stacks: [] }).length;
    if (scope.kind === "all") return t("aiScopeAll", { n });
    if (access.mode === "folders") {
      const only = access.roots.length === 1 ? folders.find((f) => f.id === access.roots[0]) : undefined;
      return only ? t("aiScopeFolder", { name: only.name, n }) : t("aiScopeFolders", { f: access.roots.length, n });
    }
    return t("aiScopeChats", { n });
  }, [runner, active.scope, folders, chats, t]);

  const configured = isConfigured(config);
  const turns = runner?.turns ?? [];

  // --- actions ------------------------------------------------------------------------

  const send = async (text: string) => {
    if (!runner || runner.running || !text.trim()) return;
    // Inside the gesture — the only moment the browser will show the prompt.
    const granted = await ensureHostPermission(config);
    if (!granted) {
      setNotice(apiErrorText("permission", originPattern(config) ?? "", t));
      return;
    }
    setNotice(null);
    setInput("");
    stick.current = true;
    await runner.send(text);
  };

  const resume = async () => {
    if (!runner || runner.running) return;
    if (!(await ensureHostPermission(config))) {
      setNotice(apiErrorText("permission", originPattern(config) ?? "", t));
      return;
    }
    stick.current = true;
    await runner.resume();
  };

  const askRewind = async (point: RewindPoint) => {
    if (!runner || runner.running) return;
    const plan = planRewind(runner.turns, point);
    const status = rewindStatus(plan, await logIndex(), await allAgentSteps());
    if (!status.ok) {
      setNotice(t("aiRewindGone"));
      return;
    }
    const body = [
      status.undo > 0 ? t("aiRewindBody", { n: status.undo }) : t("aiRewindBodyNone"),
      status.manual > 0 ? t("aiRewindManual", { n: status.manual }) : ""
    ]
      .filter(Boolean)
      .join(" ");
    setConfirm({
      title: t("aiRewindTitle"),
      body,
      confirmLabel: t("aiRewind"),
      onConfirm: async () => {
        const r = await runner.rewind(point);
        if (r === "gone") setNotice(t("aiRewindGone"));
        else if (r !== "busy") {
          if (r.restoreText !== null) {
            setInput(r.restoreText);
            requestAnimationFrame(() => inputRef.current?.focus());
          }
          if (status.undo > 0) onToast(t("aiRewound", { n: status.undo }));
        }
      }
    });
  };

  const openSessions = async (x: number, y: number) => {
    const sessions = await listSessions();
    const entries: MenuEntry[] = [
      {
        id: "new",
        label: t("aiNewSession"),
        icon: "plus",
        disabled: running,
        onClick: () => startNew()
      },
      "sep"
    ];
    if (sessions.length === 0) {
      entries.push({ id: "none", label: t("aiNoSessions"), disabled: true, onClick: () => {} });
    }
    for (const s of sessions.slice(0, 30)) {
      entries.push({
        id: s.id,
        // One line per row: the title takes the ellipsis, the date sits in the
        // right-hand slot so it is never the part that gets cut.
        label: s.title || t("aiUntitled"),
        shortcut: formatDate(new Date(s.updatedAt).toISOString(), lang, t),
        checked: s.id === runner?.session.id,
        disabled: running,
        onClick: () => reopen(s.id, s.scope)
      });
    }
    setMenu({ x, y, entries });
  };

  const startNew = () => setActive({ scope: runner?.session.scope ?? active.scope, sessionId: null, nonce: Date.now() });
  const reopen = (sessionId: string, scope: AgentScope) => setActive({ scope, sessionId, nonce: Date.now() });

  const askDeleteSession = () => {
    if (!runner || running) return;
    const id = runner.session.id;
    setConfirm({
      title: t("aiDeleteSessionTitle"),
      body: t("aiDeleteSessionBody"),
      confirmLabel: t("delete"),
      danger: true,
      onConfirm: async () => {
        await deleteSession(id);
        startNew();
      }
    });
  };

  // --- render -------------------------------------------------------------------------

  const usage = runner?.session.usage;
  const suggestions = [t("aiSuggest1"), t("aiSuggest2"), t("aiSuggest3")];

  return (
    <aside className="agent-panel" style={{ width }} aria-label={t("aiOrganize")}>
      <header className="agent-head">
        <Icon name="sparkle" size={16} />
        <div className="agent-head-text">
          <div className="agent-title">{runner?.session.title || t("aiOrganize")}</div>
          <div className="agent-scope">{scopeLabel}</div>
        </div>
        <button
          className="btn is-icon"
          title={t("aiSessions")}
          aria-label={t("aiSessions")}
          onClick={(e) => {
            // Hung from the button's right edge: the panel sits at the window's
            // right, and a menu opened from the left edge would be squeezed.
            const r = e.currentTarget.getBoundingClientRect();
            void openSessions(Math.max(8, r.right - 320), r.bottom + 4);
          }}
        >
          <Icon name="clock" size={16} />
        </button>
        <button
          className="btn is-icon"
          title={t("aiNewSession")}
          aria-label={t("aiNewSession")}
          disabled={running || turns.length === 0}
          onClick={startNew}
        >
          <Icon name="plus" size={16} />
        </button>
        {turns.length > 0 && (
          <button
            className="btn is-icon"
            title={t("aiDeleteSession")}
            aria-label={t("aiDeleteSession")}
            disabled={running}
            onClick={askDeleteSession}
          >
            <Icon name="trash" size={16} />
          </button>
        )}
        <button className="btn is-icon" title={t("close")} aria-label={t("close")} onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </header>

      <div
        className="agent-body"
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {!configured ? (
          <div className="agent-empty">
            <h3>{t("aiSetupTitle")}</h3>
            <p>{t("aiSetupBody")}</p>
            <button className="btn is-primary" onClick={onOpenSettings}>
              {t("aiOpenSettings")}
            </button>
          </div>
        ) : turns.length === 0 ? (
          <div className="agent-empty">
            <p>{t("aiIntro")}</p>
            <div className="agent-suggestions">
              {suggestions.map((s) => (
                <button
                  key={s}
                  className="agent-suggestion"
                  onClick={() => {
                    setInput(s);
                    inputRef.current?.focus();
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          layout(turns, running).map((row) => {
            switch (row.kind) {
              case "user":
                return <UserTurn key={row.key} turn={row.turn} busy={running} t={t} onRewind={askRewind} />;
              case "text":
                return <Markdown key={row.key} className="agent-text" text={row.text} />;
              case "thinking":
                return (
                  <div key={row.key} className="agent-thinking">
                    {t("aiThinking")}
                  </div>
                );
              case "tool":
                return (
                  <ToolRow
                    key={row.key}
                    block={row.block}
                    busy={running}
                    log={log}
                    t={t}
                    onRewind={() => void askRewind({ turnIdx: row.turn.idx, blockIdx: row.index })}
                    onDecide={(ok) => runner?.decide(ok)}
                  />
                );
              case "reads":
                return <ReadGroup key={row.key} items={row.items} live={row.live} log={log} t={t} />;
              case "stop":
                return (
                  <StopNotice key={row.key} turn={row.turn} maxRounds={config.maxRounds} t={t} onResume={resume} />
                );
            }
          })
        )}
      </div>

      {notice && (
        <div className="agent-notice" role="alert">
          <span>{notice}</span>
          <button className="btn is-icon" aria-label={t("close")} onClick={() => setNotice(null)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      <footer className="agent-foot">
        <textarea
          ref={inputRef}
          className="agent-input"
          rows={Math.min(6, Math.max(2, input.split("\n").length))}
          value={input}
          placeholder={t("aiPlaceholder")}
          disabled={!configured}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <div className="agent-foot-row">
          <label className="agent-toggle" title={t("aiAutoApplyHint")}>
            <input
              className="switch"
              type="checkbox"
              checked={config.autoApply}
              onChange={(e) => void port.saveAiConfig({ autoApply: e.target.checked })}
            />
            {t("aiAutoApplyShort")}
          </label>
          {usage && usage.input + usage.output > 0 && (
            <span className="agent-usage">{t("aiUsage", { in: compact(usage.input), out: compact(usage.output) })}</span>
          )}
          {running ? (
            <button className="btn" onClick={() => runner?.stop()}>
              <Icon name="stop" size={14} />
              {t("aiStop")}
            </button>
          ) : (
            <button
              className="btn is-primary"
              disabled={!configured || !input.trim()}
              onClick={() => void send(input)}
            >
              <Icon name="arrowUp" size={14} />
              {t("aiSend")}
            </button>
          )}
        </div>
      </footer>

      {confirm && <ConfirmDialog spec={confirm} onClose={() => setConfirm(null)} t={t} />}
      {menu && <ContextMenu spec={menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}

// --- turns ----------------------------------------------------------------------------

function UserTurn({
  turn,
  busy,
  t,
  onRewind
}: {
  turn: Turn;
  busy: boolean;
  t: T;
  onRewind: (p: RewindPoint) => void;
}) {
  const text = turn.blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
  return (
    <div className="agent-user">
      <button
        className="btn is-icon agent-rewind-msg"
        title={t("aiRewindMessage")}
        aria-label={t("aiRewindMessage")}
        disabled={busy}
        onClick={() => onRewind({ turnIdx: turn.idx, blockIdx: null })}
      >
        <Icon name="rewind" size={14} />
      </button>
      <div className="agent-bubble">{text}</div>
    </div>
  );
}

// --- layout -----------------------------------------------------------------------------

type Row =
  | { kind: "user"; key: string; turn: Turn }
  | { kind: "text"; key: string; text: string }
  | { kind: "thinking"; key: string }
  | { kind: "tool"; key: string; turn: Turn; index: number; block: ToolBlock }
  | { kind: "reads"; key: string; live: boolean; items: ReadItem[] }
  | { kind: "stop"; key: string; turn: Turn };

interface ReadItem {
  key: string;
  turn: Turn;
  index: number;
  block: ToolBlock;
}

/**
 * Turns → what the panel shows. The model often looks things up a dozen times
 * in a row, across several rounds, before it says anything; listed one row per
 * call that reads as busywork (user report: 27 rows for one request). A run of
 * consecutive lookups — broken only by text, a change, a question for the user
 * or the user's own message — collapses into one "查阅了 N 次" row that
 * expands on demand. Lookups carry no rewind point, so nothing is hidden.
 */
function layout(turns: Turn[], running: boolean): Row[] {
  const rows: Row[] = [];
  let run: Extract<Row, { kind: "reads" }> | null = null;
  const end = () => {
    if (!run) return;
    const only = run.items[0];
    // A lone lookup is just a row; grouping one call would only add a click.
    if (run.items.length === 1 && only && !run.live) {
      rows.push({ kind: "tool", key: only.key, turn: only.turn, index: only.index, block: only.block });
    } else {
      rows.push(run);
    }
    run = null;
  };

  turns.forEach((turn, ti) => {
    const base = `${turn.sessionId}:${turn.idx}`;
    if (turn.role === "user") {
      end();
      rows.push({ kind: "user", key: base, turn });
      return;
    }
    const live = running && ti === turns.length - 1;
    if (live && turn.blocks.length === 0) {
      // Still waiting for the first token: an open run shows it as its own
      // "running" state instead of a separate line.
      if (run) run.live = true;
      else rows.push({ kind: "thinking", key: `${base}:thinking` });
    }
    turn.blocks.forEach((b, i) => {
      const key = `${base}:${i}`;
      if (b.type === "text") {
        if (!b.text.trim()) return;
        end();
        rows.push({ kind: "text", key, text: b.text });
        return;
      }
      const lookup = b.name !== WRITE_TOOL && b.name !== REMEMBER_TOOL && b.status !== "awaiting";
      if (!lookup) {
        end();
        rows.push({ kind: "tool", key, turn, index: i, block: b });
        return;
      }
      run ??= { kind: "reads", key, live: false, items: [] };
      run.items.push({ key, turn, index: i, block: b });
      if (live) run.live = true;
    });
    if (turn.stop && !running) {
      end();
      rows.push({ kind: "stop", key: `${base}:stop`, turn });
    }
  });
  end();
  return rows;
}

function ReadGroup({
  items,
  live,
  log,
  t
}: {
  items: ReadItem[];
  live: boolean;
  log: { seqs: number[]; cursor: number };
  t: T;
}) {
  const [open, setOpen] = useState(false);
  const searches = items.filter((it) => it.block.name === "search_chats").length;
  const failed = items.filter((it) => it.block.status === "error").length;
  const lastBrief = items.at(-1)?.block.brief;
  return (
    <div className={`agent-tool agent-reads${live ? " is-running" : ""}`}>
      <button className="agent-tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <Icon name="search" size={14} />
        <span className="agent-tool-brief">
          {t("aiReadGroup", { n: items.length })}
          <span className="agent-reads-detail">
            {t("aiReadGroupDetail", { read: items.length - searches, search: searches })}
          </span>
        </span>
        {(live || failed > 0) && (
          <span className="agent-tool-status">
            {live ? t("aiStatusRunning") : t("aiReadGroupFailed", { n: failed })}
          </span>
        )}
      </button>
      {!open && live && lastBrief && <div className="agent-reads-now">{say(t, lastBrief)}</div>}
      {open && (
        <div className="agent-reads-list">
          {items.map((it) => (
            <ToolRow key={it.key} block={it.block} busy={false} log={log} t={t} onRewind={() => {}} onDecide={() => {}} />
          ))}
        </div>
      )}
    </div>
  );
}

function StopNotice({
  turn,
  maxRounds,
  t,
  onResume
}: {
  turn: Turn;
  maxRounds: number;
  t: T;
  onResume: () => void;
}) {
  const text =
    turn.stop === "error"
      ? apiErrorText(turn.errorKind, turn.error, t)
      : turn.stop === "aborted"
        ? t("aiStopped")
        : turn.stop === "round_limit"
          ? t("aiRoundLimit", { n: maxRounds })
          : turn.stop === "max_tokens"
            ? t("aiCutOff")
            : "";
  if (!text) return null;
  return (
    <div className={`agent-stop${turn.stop === "error" ? " is-error" : ""}`}>
      <span>{text}</span>
      <button className="btn" onClick={onResume}>
        {turn.stop === "error" ? t("aiRetry") : t("aiContinue")}
      </button>
    </div>
  );
}

function ToolRow({
  block,
  busy,
  log,
  t,
  onRewind,
  onDecide
}: {
  block: ToolBlock;
  busy: boolean;
  log: { seqs: number[]; cursor: number };
  t: T;
  onRewind: () => void;
  onDecide: (ok: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [allLines, setAllLines] = useState(false);
  const write = block.name === WRITE_TOOL;
  // A proposed preference asks for a decision too, so it looks like a batch.
  const remember = block.name === REMEMBER_TOOL;
  const step = typeof block.seq === "number" ? stepState(block.seq, log) : null;
  const deleting = (block.preview ?? []).some((l) => l.key === "aiPvDeleteChats" || l.key === "aiPvDeleteFolder");

  const status =
    block.status === "running"
      ? t("aiStatusRunning")
      : block.status === "awaiting"
        ? t("aiStatusAwaiting")
        : block.status === "error"
          ? t("aiStatusFailed")
          : block.status === "rejected"
            ? t("aiStatusRejected")
            : step === "undone"
              ? t("aiStepUndone")
              : step === "gone"
                ? t("aiStepGone")
                : "";

  const brief = block.brief ? say(t, block.brief) : block.name || "…";
  const preview = block.preview ?? [];
  const shown = allLines ? preview : preview.slice(0, PLAN_LINES);

  let pretty = block.rawInput;
  try {
    pretty = JSON.stringify(block.input ?? JSON.parse(block.rawInput || "{}"), null, 2);
  } catch {
    // keep the raw text — it is what the model actually sent
  }

  return (
    <div className={`agent-tool is-${block.status}${write || remember ? " is-write" : ""}${step === "undone" ? " is-undone" : ""}`}>
      <button className="agent-tool-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        <Icon name={write ? "folder" : remember ? "bookmark" : "search"} size={14} />
        <span className="agent-tool-brief">{brief}</span>
        {status && <span className="agent-tool-status">{status}</span>}
      </button>

      {(write || remember) && preview.length > 0 && (
        <ul className="agent-plan">
          {shown.map((l, i) => (
            <li key={i}>{say(t, l)}</li>
          ))}
          {!allLines && preview.length > PLAN_LINES && (
            <li>
              <button className="agent-link" onClick={() => setAllLines(true)}>
                {t("aiMoreLines", { n: preview.length - PLAN_LINES })}
              </button>
            </li>
          )}
        </ul>
      )}
      {write && (block.errors ?? []).length > 0 && (
        <ul className="agent-plan is-errors">
          {(block.errors ?? []).map((l, i) => (
            <li key={i}>{say(t, l)}</li>
          ))}
        </ul>
      )}

      {block.status === "awaiting" && (
        <div className="agent-approve">
          <button className="btn" onClick={() => onDecide(false)}>
            {t("aiReject")}
          </button>
          <button className={`btn is-primary${deleting ? " is-danger" : ""}`} onClick={() => onDecide(true)}>
            {remember ? t("aiRemember") : deleting ? t("aiApplyDelete") : t("aiApply")}
          </button>
        </div>
      )}

      {write && step && step !== "gone" && (
        <div className="agent-tool-foot">
          <button className="agent-link" disabled={busy} onClick={onRewind}>
            <Icon name="rewind" size={12} />
            {t("aiRewindHere")}
          </button>
        </div>
      )}

      {open && (
        <div className="agent-tool-detail">
          <div className="agent-tool-label">{t("aiParams")}</div>
          <pre>{pretty || "{}"}</pre>
          {block.output !== undefined && (
            <>
              <div className="agent-tool-label">{t("aiResult")}</div>
              <pre>{block.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
