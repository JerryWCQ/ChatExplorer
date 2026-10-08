/**
 * Self-drawn floating layers (user decision: never the browser's own
 * confirm/alert). Dialog, toast stack, context menu, list picker, settings.
 */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import { historyLog, type HistoryLog } from "../core/ops";
import { ICON_SIZE } from "../core/schema";
import type { Settings } from "../core/settings";
import { formatDate } from "../ui/format";
import { Icon, type IconName } from "../ui/Icon";
import type { Lang, T } from "../ui/i18n";
import { onDataChanged } from "./dataport";
import { AiSettings } from "./agent-settings";

// --- confirm dialog ----------------------------------------------------------

export interface ConfirmSpec {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  spec,
  onClose,
  t
}: {
  spec: ConfirmSpec;
  onClose: () => void;
  t: T;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);
  return (
    <div
      className="overlay-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="dialog" role="alertdialog" aria-label={spec.title}>
        <h2>{spec.title}</h2>
        <p>{spec.body}</p>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            ref={confirmRef}
            className={spec.danger ? "btn is-primary is-danger" : "btn is-primary"}
            onClick={() => {
              void spec.onConfirm();
              onClose();
            }}
          >
            {spec.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- toast stack ---------------------------------------------------------------

export interface ToastSpec {
  id: number;
  message: string;
  /** Label of the inline action button, usually "Undo". */
  actionLabel?: string;
  onAction?: () => void;
}

export function ToastHost({ toasts, onExpire }: { toasts: ToastSpec[]; onExpire: (id: number) => void }) {
  return (
    <div className="toast-host">
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} onExpire={onExpire} />
      ))}
    </div>
  );
}

function ToastRow({ toast, onExpire }: { toast: ToastSpec; onExpire: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onExpire(toast.id), 5000);
    return () => clearTimeout(timer);
  }, [toast.id, onExpire]);
  return (
    <div className="toast">
      <span>{toast.message}</span>
      {toast.actionLabel && toast.onAction && (
        <button
          onClick={() => {
            toast.onAction?.();
            onExpire(toast.id);
          }}
        >
          {toast.actionLabel}
        </button>
      )}
    </div>
  );
}

// --- select ----------------------------------------------------------------------

/**
 * A drop-down that we draw ourselves.
 *
 * `<select>` was the last native widget left in the app, and its popup is drawn
 * by the OS: Windows renders it as a white list with a blue highlight, which in
 * a warm-paper dark-capable UI is the one surface that never follows the theme
 * (user report). Everything else — dialogs, menus, toasts, confirmations — is
 * already self-drawn for exactly this reason, so this is consistency, not
 * decoration.
 *
 * The list reuses `.menu`, because a drop-down *is* a menu anchored to a
 * control; a second popup idiom would be a second thing to keep in step.
 *
 * Keyboard behaviour matches the native one closely enough not to surprise:
 * Enter/Space/Down opens, Up/Down moves, Enter commits, Escape cancels, and
 * focus returns to the button either way.
 */
export function Select<V extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: V;
  options: readonly { value: V; label: string }[];
  onChange: (value: V) => void;
  label?: string;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [box, setBox] = useState({ left: 0, top: 0, width: 0 });

  const currentIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );

  const openList = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setActive(currentIndex);
    setBox({ left: r.left, top: r.bottom + 4, width: r.width });
    setOpen(true);
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };

  const commit = (v: V) => {
    onChange(v);
    close(true);
  };

  // Once the popup has a size, keep it on screen — a drop-down near the bottom
  // of the settings dialog would otherwise open past the viewport edge.
  useEffect(() => {
    const el = popRef.current;
    if (!open || !el) return;
    el.focus();
    const r = el.getBoundingClientRect();
    const anchor = btnRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const flipped = r.bottom > window.innerHeight - 4 ? anchor.top - r.height - 4 : anchor.bottom + 4;
    setBox((prev) =>
      prev.top === flipped ? prev : { ...prev, top: Math.max(4, flipped) }
    );
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) close(false);
    };
    // Both removed on close. An anonymous listener here would have been
    // unremovable, which is a listener per open for the life of the page.
    const gone = () => close(false);
    window.addEventListener("mousedown", away, true);
    window.addEventListener("blur", gone);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("blur", gone);
    };
  }, [open]);

  const onListKey = (e: ReactKeyboardEvent) => {
    // Swallowed before they reach the dialog, or Escape would close the whole
    // settings panel instead of just this list.
    if (e.key === "Escape") {
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = options[active];
      if (opt) commit(opt.value);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="select"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openList();
          }
        }}
      >
        <span className="select-value">{options[currentIndex]?.label ?? ""}</span>
        <Icon name="chevronDown" size={14} />
      </button>

      {open && (
        <div className="context-menu-host" style={{ left: box.left, top: box.top }}>
          <div
            ref={popRef}
            className="menu"
            role="listbox"
            tabIndex={-1}
            style={{ minWidth: box.width }}
            onKeyDown={onListKey}
          >
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`menu-item${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(o.value)}
              >
                {/* Same dot as the context menus, for one vocabulary of
                    "this is the setting you are on". */}
                <span className="menu-mark">
                  {o.value === value && <span className="menu-dot" />}
                </span>
                <span>{o.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// --- context menu ----------------------------------------------------------------

export type MenuEntry =
  | "sep"
  | {
      id: string;
      label: string;
      icon?: IconName;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      /**
       * Present = this entry is a state toggle, and gets a radio dot in the
       * left gutter (Windows Explorer's 查看 menu, per user decision — a tick
       * appended to the label was the old, cruder form). Absent = a command.
       */
      checked?: boolean;
      onClick: () => void;
    };

export interface MenuSpec {
  x: number;
  y: number;
  entries: MenuEntry[];
}

export function ContextMenu({ spec, onClose }: { spec: MenuSpec; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: spec.x, y: spec.y });

  useEffect(() => {
    // Flip inside the viewport once the size is known.
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(spec.x, Math.max(0, window.innerWidth - r.width - 4)),
      y: Math.min(spec.y, Math.max(0, window.innerHeight - r.height - 4))
    });
  }, [spec.x, spec.y]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // One gutter for the whole menu, not per entry: a dot on some rows and
  // nothing on others still has to leave the labels aligned.
  const marked = spec.entries.some((e) => e !== "sep" && e.checked !== undefined);

  return (
    <div ref={ref} className="context-menu-host" style={{ left: pos.x, top: pos.y }}>
      <div className="menu" role="menu">
        {spec.entries.map((entry, i) =>
          entry === "sep" ? (
            <div key={`sep-${i}`} className="menu-sep" />
          ) : (
            <button
              key={entry.id}
              className={entry.danger ? "menu-item is-danger" : "menu-item"}
              disabled={entry.disabled}
              role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={entry.checked}
              onClick={() => {
                onClose();
                entry.onClick();
              }}
            >
              {marked && (
                <span className="menu-mark">
                  {entry.checked && <span className="menu-dot" />}
                </span>
              )}
              {entry.icon && <Icon name={entry.icon} size={14} />}
              <span className="menu-label" title={entry.label}>
                {entry.label}
              </span>
              {entry.shortcut && <span className="menu-shortcut">{entry.shortcut}</span>}
            </button>
          )
        )}
      </div>
    </div>
  );
}

// --- list picker (quick jump, folder picker) ----------------------------------------

export interface PickerOption {
  id: string;
  name: string;
  icon: IconName;
  /** Secondary text at the right edge, e.g. the folder path. */
  path?: string;
}

export function Picker({
  placeholder,
  options,
  filter,
  onPick,
  onClose
}: {
  placeholder: string;
  options: PickerOption[];
  /** Normalised match; receives (option, normalizedQuery). */
  filter: (option: PickerOption, query: string) => boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = query.trim() === "" ? options.slice(0, 100) : options.filter((o) => filter(o, query)).slice(0, 100);
  const clamped = Math.min(active, Math.max(0, shown.length - 1));

  useEffect(() => {
    listRef.current
      ?.querySelector(".picker-item.is-active")
      ?.scrollIntoView({ block: "nearest" });
  }, [clamped, query]);

  return (
    <div
      className="overlay-scrim is-top"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="picker">
        <input
          className="picker-input"
          autoFocus
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, shown.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              const hit = shown[clamped];
              if (hit) {
                onClose();
                onPick(hit.id);
              }
            }
          }}
        />
        <div className="picker-list" ref={listRef}>
          {shown.length === 0 && <div className="picker-empty">—</div>}
          {shown.map((option, i) => (
            <div
              key={option.id}
              className={i === clamped ? "picker-item is-active" : "picker-item"}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onClose();
                onPick(option.id);
              }}
            >
              <Icon name={option.icon} size={14} />
              <span className="picker-name">{option.name}</span>
              {option.path && <span className="picker-path">{option.path}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --- settings panel --------------------------------------------------------------------

export function SettingsPanel({
  settings,
  counts,
  onSave,
  onClose,
  onSyncNow,
  t
}: {
  settings: Settings;
  counts: { chats: number; lastSync: string };
  onSave: (patch: Partial<Settings>) => void;
  onClose: () => void;
  onSyncNow: () => void;
  t: T;
}) {
  const row = (label: string, control: ReactNode) => (
    <div className="settings-row">
      <label>{label}</label>
      {control}
    </div>
  );

  /** A note under a row, for options whose trade-off is not obvious from the label. */
  const hint = (text: string) => <p className="settings-hint">{text}</p>;

  return (
    <div
      className="overlay-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="settings-panel" role="dialog" aria-label={t("settings")}>
        <h2>{t("settings")}</h2>

        <h3>{t("settingsAppearance")}</h3>
        {row(
          t("theme"),
          <Select
            label={t("theme")}
            value={settings.theme}
            options={[
              { value: "system", label: t("themeSystem") },
              { value: "light", label: t("themeLight") },
              { value: "dark", label: t("themeDark") }
            ]}
            onChange={(theme) => onSave({ theme })}
          />
        )}
        {row(
          t("language"),
          <Select
            label={t("language")}
            value={settings.language}
            options={[
              { value: "auto", label: t("languageAuto") },
              { value: "zh-CN", label: "中文" },
              { value: "en", label: "English" }
            ]}
            onChange={(language) => onSave({ language })}
          />
        )}
        {row(
          t("defaultIconSize"),
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              className="slider"
              type="range"
              min={ICON_SIZE.min}
              max={ICON_SIZE.max}
              step={8}
              value={settings.defaultIconSize}
              onChange={(e) => onSave({ defaultIconSize: Number(e.target.value) })}
            />
            <span className="settings-value">{settings.defaultIconSize}px</span>
          </span>
        )}
        {row(
          t("rowDensity"),
          <Select
            label={t("rowDensity")}
            value={settings.defaultDensity}
            options={[
              { value: "compact", label: t("densityCompact") },
              { value: "comfortable", label: t("densityComfortable") }
            ]}
            onChange={(defaultDensity) => onSave({ defaultDensity })}
          />
        )}

        <h3>{t("settingsBehaviour")}</h3>
        {row(
          t("openMode"),
          <Select
            label={t("openMode")}
            value={settings.openMode}
            options={[
              { value: "newTab", label: t("openModeNewTab") },
              { value: "focusExisting", label: t("openModeFocus") },
              { value: "reuseTab", label: t("openModeReuse") }
            ]}
            onChange={(openMode) => onSave({ openMode })}
          />
        )}
        {settings.openMode === "reuseTab" && hint(t("openModeReuseHint"))}
        {row(
          t("showCheckboxes"),
          <input
            className="switch"
            type="checkbox"
            checked={settings.showCheckboxes}
            onChange={(e) => onSave({ showCheckboxes: e.target.checked })}
          />
        )}
        {row(
          t("previewDefault"),
          <input
            className="switch"
            type="checkbox"
            checked={settings.previewPaneDefault}
            onChange={(e) => onSave({ previewPaneDefault: e.target.checked })}
          />
        )}
        {row(
          t("recentCount"),
          <Select
            label={t("recentCount")}
            value={String(settings.recentCount)}
            options={[20, 50, 100, 200].map((n) => ({ value: String(n), label: String(n) }))}
            onChange={(v) => onSave({ recentCount: Number(v) })}
          />
        )}

        <h3>{t("settingsSync")}</h3>
        {row(
          t("autoSync"),
          <Select
            label={t("autoSync")}
            value={String(settings.autoSyncMinutes)}
            options={[
              { value: "0", label: t("autoSyncOff") },
              ...[15, 30, 60].map((n) => ({ value: String(n), label: t("minutes", { n }) }))
            ]}
            onChange={(v) => onSave({ autoSyncMinutes: Number(v) })}
          />
        )}
        {row(
          t("lastSync"),
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="settings-value" style={{ minWidth: 0 }}>
              {counts.lastSync}
            </span>
            <button className="btn" onClick={onSyncNow}>
              {t("syncNow")}
            </button>
          </span>
        )}

        <h3>{t("settingsAi")}</h3>
        <AiSettings t={t} />

        <h3>{t("settingsAbout")}</h3>
        {row(
          t("version"),
          // Read from the manifest, so it cannot drift from what Edge shows.
          <span className="settings-value">
            {typeof chrome !== "undefined" && chrome.runtime?.getManifest
              ? chrome.runtime.getManifest().version
              : "dev"}
          </span>
        )}
        {row(t("itemCount", { n: counts.chats }), <span />)}
        {row(
          t("debugToasts"),
          <input
            className="switch"
            type="checkbox"
            checked={settings.debug}
            onChange={(e) => onSave({ debug: e.target.checked })}
          />
        )}
        {hint(t("debugToastsHint"))}

        <div className="dialog-actions" style={{ marginTop: 16 }}>
          <button className="btn is-primary" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- history panel ---------------------------------------------------------------------

/**
 * 「查看历史记录…支持回到某个动作之前…右键可以取消回退」.
 *
 * The user found the model confusing (「感觉逻辑有点绕」), and they were right to:
 * the obvious reading — record each undo as a new action — regresses forever
 * (undoing an undo is itself an action to be undone). So the panel is built on
 * the one invariant that does not regress:
 *
 *   The log is a straight line of actions. A cursor says how far along it you
 *   currently are. Going back and going forward are the *same* move, they just
 *   point in opposite directions, and neither one writes to the log.
 *
 * That gives every affordance asked for. Clicking a step below the cursor winds
 * back to it (「回到某个动作之前」 — click the step before the one you regret).
 * Steps above the cursor stay in the list, greyed, labelled 已回退; clicking one
 * winds forward again (「取消回退」). Doing something new truncates the greyed
 * tail, exactly like every undo stack the user has ever used.
 *
 * The panel owns its own data. `useAppData` refuses to carry it because that
 * would re-read up to 200 transaction records on every single write anywhere in
 * the app, to feed a dialog that is shut almost all of the time.
 */
export function HistoryPanel({
  onJump,
  onClose,
  t,
  lang
}: {
  onJump: (seq: number) => void;
  onClose: () => void;
  t: T;
  lang: Lang;
}) {
  const [log, setLog] = useState<HistoryLog | null>(null);
  const [menu, setMenu] = useState<(MenuSpec & { seq: number }) | null>(null);

  useEffect(() => {
    let alive = true;
    const read = () => {
      void historyLog().then((next) => {
        if (alive) setLog(next);
      });
    };
    read();
    const off = onDataChanged(read);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const rows = log ? [...log.entries].reverse() : [];
  const cursor = log?.cursor ?? 0;

  const jump = (seq: number) => {
    setMenu(null);
    if (seq !== cursor) onJump(seq);
  };

  /** Shared by the entry rows and by the synthetic 「初始状态」 row at the bottom. */
  const row = (seq: number, main: ReactNode, meta: ReactNode) => {
    const current = seq === cursor;
    const undone = seq > cursor;
    return (
      <div
        key={seq}
        className={`history-row${current ? " is-current" : ""}${undone ? " is-undone" : ""}`}
        role="button"
        tabIndex={0}
        aria-current={current}
        onClick={() => jump(seq)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            jump(seq);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (current) return;
          setMenu({
            x: e.clientX,
            y: e.clientY,
            seq,
            entries: [
              {
                id: "jump",
                // Winding back lands you *before* the step above the target, so
                // the two directions genuinely need different words.
                label: undone ? t("historyRedoTo") : t("historyGoBefore"),
                icon: undone ? "arrowRight" : "arrowLeft",
                onClick: () => jump(seq)
              }
            ]
          });
        }}
      >
        <span className="history-dot" aria-hidden="true" />
        <span className="history-main">{main}</span>
        <span className="history-meta">{meta}</span>
        {current && <span className="history-badge">{t("historyCurrent")}</span>}
        {undone && <span className="history-badge is-undone">{t("historyUndone")}</span>}
      </div>
    );
  };

  return (
    <div
      className="overlay-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="history-panel" role="dialog" aria-label={t("historyTitle")}>
        <h2>{t("historyTitle")}</h2>
        <p className="settings-hint">{t("historyHint")}</p>

        {/* Newest first, so the thing you just did — and most likely want to
            take back — is the first thing under your cursor. */}
        <div className="history-list">
          {log && rows.length === 0 && <p className="history-empty">{t("historyEmpty")}</p>}
          {rows.map((e) =>
            row(
              e.seq,
              t(e.label.key, e.label.vars),
              <>
                <span>{formatDate(new Date(e.ts).toISOString(), lang, t)}</span>
                <span className="history-size">{t("historyWrites", { n: e.size })}</span>
              </>
            )
          )}
          {log && rows.length > 0 && row(0, t("historyStart"), <span />)}
        </div>

        <div className="dialog-actions" style={{ marginTop: 16 }}>
          <button className="btn is-primary" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
      {menu && <ContextMenu spec={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
