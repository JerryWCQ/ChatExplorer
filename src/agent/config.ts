/**
 * The organizer's connection settings, and the permission to reach them.
 *
 * Stored under its own meta key, not inside `Settings`: an API key must not
 * ride along with anything that ever exports, syncs or logs the settings
 * object. The backup export does not include either today; keeping the key
 * apart means it cannot start to by accident.
 */

import { getMeta, setMeta } from "../core/db";
import { META_KEY } from "../core/schema";
import { endpointUrl } from "./providers";
import { DEFAULT_AI_CONFIG, type AiConfig } from "./types";

export async function loadAiConfig(): Promise<AiConfig> {
  const stored = await getMeta<Partial<AiConfig>>(META_KEY.aiConfig);
  return { ...DEFAULT_AI_CONFIG, ...stored };
}

export async function saveAiConfig(patch: Partial<AiConfig>): Promise<AiConfig> {
  const next = { ...(await loadAiConfig()), ...patch };
  await setMeta(META_KEY.aiConfig, next);
  return next;
}

/** Enough filled in to try a request. */
export function isConfigured(cfg: AiConfig): boolean {
  return !!cfg.apiKey.trim() && !!cfg.model.trim();
}

/** "https://relay.example.com/*" — the match pattern for one origin. */
export function originPattern(cfg: Pick<AiConfig, "protocol" | "baseUrl">): string | null {
  try {
    return `${new URL(endpointUrl(cfg)).origin}/*`;
  } catch {
    return null;
  }
}

/**
 * Ask for the one origin the endpoint lives on (`optional_host_permissions`
 * in the manifest), rather than all sites up front.
 *
 * Must run inside a user gesture — the Send button, the Enter key, 测试连接.
 * When the origin is already granted Chrome answers true without a prompt, so
 * callers simply call this every time. Outside the extension (the dev server)
 * there is no permission system and nothing to ask.
 */
export async function ensureHostPermission(cfg: AiConfig): Promise<boolean> {
  const pattern = originPattern(cfg);
  if (!pattern) return false;
  const perms = typeof chrome === "undefined" ? undefined : chrome.permissions;
  if (!perms?.request) return true;
  try {
    return await perms.request({ origins: [pattern] });
  } catch {
    return false;
  }
}
