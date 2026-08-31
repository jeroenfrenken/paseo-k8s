import type { PluginTheme } from "@getpaseo/plugin";
import type { Health } from "./contracts";

/**
 * Status palette — fixed in both appearances, never themed, never reused for
 * anything that is not a state. Each colour is always paired with a glyph and a
 * word so state never rides on hue alone.
 */
export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
  neutral: "#898781",
} as const;

export const HEALTH_STYLE: Record<Health, { color: string; glyph: string; label: string }> = {
  healthy: { color: STATUS.good, glyph: "●", label: "Healthy" },
  progressing: { color: STATUS.warning, glyph: "▲", label: "Progressing" },
  degraded: { color: STATUS.serious, glyph: "◆", label: "Degraded" },
  down: { color: STATUS.critical, glyph: "■", label: "Down" },
  unknown: { color: STATUS.neutral, glyph: "○", label: "Idle" },
};

export const PHASE_ORDER = ["running", "pending", "succeeded", "failed", "unknown"] as const;
export type PhaseKey = (typeof PHASE_ORDER)[number];

export const PHASE_STYLE: Record<PhaseKey, { color: string; glyph: string; label: string }> = {
  running: { color: STATUS.good, glyph: "●", label: "Running" },
  pending: { color: STATUS.warning, glyph: "▲", label: "Pending" },
  succeeded: { color: STATUS.neutral, glyph: "○", label: "Succeeded" },
  failed: { color: STATUS.critical, glyph: "■", label: "Failed" },
  unknown: { color: STATUS.serious, glyph: "◆", label: "Unknown" },
};

export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((char) => char + char).join("") : value;
  const red = Number.parseInt(full.slice(0, 2), 16);
  const green = Number.parseInt(full.slice(2, 4), 16);
  const blue = Number.parseInt(full.slice(4, 6), 16);
  if (Number.isNaN(red) || Number.isNaN(green) || Number.isNaN(blue)) return hex;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

export interface Tokens {
  mono: string;
  surface: string;
  raised: string;
  row: string;
  rowSelected: string;
  border: string;
  ink: string;
  muted: string;
  accent: string;
  accentInk: string;
}

export function tokensFor(theme: PluginTheme, platform: "ios" | "android" | "web"): Tokens {
  const ink = theme.colors.foreground;
  return {
    mono: platform === "ios" ? "Menlo" : "monospace",
    surface: theme.colors.surface0,
    raised: withAlpha(ink, 0.04),
    row: withAlpha(ink, 0.03),
    rowSelected: withAlpha(theme.colors.accent, 0.16),
    border: withAlpha(ink, 0.1),
    ink,
    muted: theme.colors.foregroundMuted,
    accent: theme.colors.accent,
    accentInk: theme.colors.accentForeground,
  };
}

export function formatAge(iso: string | null): string {
  if (!iso) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** `2026-08-28T12:59:12.783012345Z` -> `12:59:12`, without going via Date. */
export function clockTime(timestamp: string | null): string | null {
  if (!timestamp) return null;
  const match = /T(\d{2}:\d{2}:\d{2})/.exec(timestamp);
  return match ? match[1] : null;
}

export function formatCpu(milli: number | null): string {
  if (milli === null) return "—";
  if (milli < 1) return milli === 0 ? "0" : "<1m";
  if (milli < 1000) return `${Math.round(milli)}m`;
  return `${(milli / 1000).toFixed(2)}`;
}

export function formatMemory(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes}B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}${units[unit]}`;
}

export function shortImage(image: string): string {
  const withoutDigest = image.split("@")[0];
  const parts = withoutDigest.split("/");
  return parts[parts.length - 1] || withoutDigest;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
