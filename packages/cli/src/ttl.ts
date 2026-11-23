// --ttl parsing: <n>s|m|h|d, a bare number of seconds, or "never"
// (persistent: true, which needs an API key). The server enforces the minimum and maximum.
import { usageError } from "./errors.ts";

export type Lifetime = { kind: "ttl"; seconds: number } | { kind: "persistent" };

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

export function parseTtl(raw: string): Lifetime {
  const value = raw.trim().toLowerCase();
  if (value === "never") return { kind: "persistent" };
  const m = /^(\d{1,12})([smhd]?)$/.exec(value);
  if (!m) throw usageError(`Invalid --ttl ${JSON.stringify(raw)}: use a number with s, m, h or d (for example 30m, 24h, 7d), or never.`);
  const seconds = Number(m[1]) * (UNITS[m[2] || "s"] as number);
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw usageError(`Invalid --ttl ${JSON.stringify(raw)}: it must be at least 1 second.`);
  return { kind: "ttl", seconds };
}

/** The create request fields for a lifetime (none when the server default applies). */
export function lifetimeFields(lifetime: Lifetime | null): { ttl_seconds?: number; persistent?: true } {
  if (lifetime === null) return {};
  return lifetime.kind === "persistent" ? { persistent: true } : { ttl_seconds: lifetime.seconds };
}
