/**
 * Settings → AI 整理: the connection to the user's own API (官方 or 中转站).
 *
 * Owns its state rather than riding on `Settings`, for the same reason the
 * config is stored apart (see `agent/config.ts`). Text fields save on blur, so
 * a half-typed URL is never persisted mid-keystroke; toggles save at once.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, testConnection } from "../agent/client";
import { ensureHostPermission, isConfigured, loadAiConfig, originPattern } from "../agent/config";
import { DEFAULT_BASE, endpointUrl } from "../agent/providers";
import type { AiConfig } from "../agent/types";
import { DEFAULT_AI_CONFIG } from "../agent/types";
import { Icon } from "../ui/Icon";
import type { T } from "../ui/i18n";
import { onDataChanged, port } from "./dataport";
import { Select } from "./overlays";

/** One sentence the user can act on, for every way a request can fail. */
export function apiErrorText(kind: string | undefined, detail: string | undefined, t: T): string {
  const d = (detail ?? "").trim();
  switch (kind) {
    case "auth":
      return t("aiErrAuth", { detail: d });
    case "notfound":
      return t("aiErrNotFound", { detail: d });
    case "rate":
      return t("aiErrRate", { detail: d });
    case "server":
      return t("aiErrServer", { detail: d });
    case "network":
      return t("aiErrNetwork");
    case "permission":
      return t("aiErrPermission", { origin: d });
    default:
      return t("aiErrRequest", { detail: d });
  }
}

export function AiSettings({ t }: { t: T }) {
  const [cfg, setCfg] = useState<AiConfig>(DEFAULT_AI_CONFIG);
  const [draft, setDraft] = useState({ baseUrl: "", apiKey: "", model: "", preferences: "" });
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<{ state: "idle" | "running" | "ok" | "fail"; text: string }>({
    state: "idle",
    text: ""
  });
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      void loadAiConfig().then((c) => {
        if (!live) return;
        setCfg(c);
        setDraft({ baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model, preferences: c.preferences });
      });
    load();
    const off = onDataChanged(load);
    return () => {
      live = false;
      off();
      abort.current?.abort();
    };
  }, []);

  const save = (patch: Partial<AiConfig>) => {
    setCfg((c) => ({ ...c, ...patch }));
    void port.saveAiConfig(patch);
  };
  const commitText = (key: keyof typeof draft) => {
    const value = draft[key].trim();
    if (value !== cfg[key]) save({ [key]: value });
  };

  const current: AiConfig = { ...cfg, ...draft };

  const runTest = async () => {
    // Save first, so the test and the next session use the same values.
    save({ baseUrl: draft.baseUrl.trim(), apiKey: draft.apiKey.trim(), model: draft.model.trim() });
    // Asked inside the click, the one moment the browser allows the prompt.
    const granted = await ensureHostPermission(current);
    if (!granted) {
      setTest({ state: "fail", text: apiErrorText("permission", originPattern(current) ?? "", t) });
      return;
    }
    abort.current?.abort();
    abort.current = new AbortController();
    setTest({ state: "running", text: "" });
    try {
      const r = await testConnection(current, abort.current.signal);
      setTest({ state: "ok", text: t("aiTestOk", { s: (r.ms / 1000).toFixed(1), reply: r.text || "…" }) });
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      setTest({ state: "fail", text: apiErrorText(e?.kind, e ? `${e.status || ""} ${e.detail}`.trim() : String(err), t) });
    }
  };

  const row = (label: string, control: ReactNode) => (
    <div className="settings-row">
      <label>{label}</label>
      {control}
    </div>
  );
  const hint = (text: string) => <p className="settings-hint">{text}</p>;
  const text = (key: keyof typeof draft, placeholder: string, type = "text") => (
    <input
      className="input settings-input"
      type={type}
      value={draft[key]}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
      onBlur={() => commitText(key)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );

  return (
    <>
      {row(
        t("aiProtocol"),
        <Select
          label={t("aiProtocol")}
          value={cfg.protocol}
          options={[
            { value: "anthropic", label: t("aiProtocolAnthropic") },
            { value: "openai", label: t("aiProtocolOpenAI") }
          ]}
          onChange={(protocol) => save({ protocol })}
        />
      )}
      {row(t("aiBaseUrl"), text("baseUrl", DEFAULT_BASE[cfg.protocol]))}
      {hint(t("aiEndpointIs", { url: endpointUrl(current) }))}
      {row(
        t("aiApiKey"),
        <span className="settings-inline">
          {text("apiKey", "sk-…", showKey ? "text" : "password")}
          <button
            type="button"
            className="btn is-icon"
            title={showKey ? t("aiHideKey") : t("aiShowKey")}
            aria-label={showKey ? t("aiHideKey") : t("aiShowKey")}
            onClick={() => setShowKey((v) => !v)}
          >
            <Icon name={showKey ? "eyeOff" : "eye"} size={14} />
          </button>
        </span>
      )}
      {row(
        t("aiModel"),
        text("model", cfg.protocol === "anthropic" ? "claude-sonnet-4-5" : "gpt-4.1 / claude-sonnet-4-5")
      )}
      {row(
        t("aiAuthStyle"),
        <Select
          label={t("aiAuthStyle")}
          value={cfg.authStyle}
          options={[
            { value: "auto", label: t("aiAuthAuto") },
            { value: "x-api-key", label: "x-api-key" },
            { value: "bearer", label: "Authorization: Bearer" }
          ]}
          onChange={(authStyle) => save({ authStyle })}
        />
      )}
      {row(
        t("aiAutoApply"),
        <input
          className="switch"
          type="checkbox"
          checked={cfg.autoApply}
          onChange={(e) => save({ autoApply: e.target.checked })}
        />
      )}
      {hint(t("aiAutoApplyHint"))}
      {row(
        t("aiMaxRounds"),
        <Select
          label={t("aiMaxRounds")}
          value={String(cfg.maxRounds)}
          options={[20, 40, 80, 150].map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(v) => save({ maxRounds: Number(v) })}
        />
      )}
      <div className="settings-stack">
        <label htmlFor="ai-preferences">{t("aiPreferences")}</label>
        <textarea
          id="ai-preferences"
          className="input settings-textarea"
          rows={4}
          value={draft.preferences}
          placeholder={t("aiPreferencesPlaceholder")}
          onChange={(e) => setDraft((d) => ({ ...d, preferences: e.target.value }))}
          onBlur={() => commitText("preferences")}
        />
      </div>
      {hint(t("aiPreferencesHint"))}
      {row(
        t("aiTest"),
        <span className="settings-inline">
          {test.state !== "idle" && (
            <span className={`settings-value ai-test is-${test.state}`}>
              {test.state === "running" ? t("aiTesting") : test.state === "ok" ? t("aiTestPassed") : t("aiTestFailed")}
            </span>
          )}
          <button
            className="btn"
            disabled={test.state === "running" || !isConfigured(current)}
            onClick={() => void runTest()}
          >
            {t("aiTest")}
          </button>
        </span>
      )}
      {test.text && hint(test.text)}
      {hint(t("aiKeyLocal"))}
    </>
  );
}
