// The API's `fix` in CLI terms (CLI 0.3.1).
// The API writes `fix` for HTTP callers, so it names headers and body fields (`Authorization`,
// `ttl_seconds`, `persistent`) rather than CLI flags. The CLI rewrites a `fix` only when the API
// sent a sentence listed in RECOGNISED_API_FIXES, in a phase where the rewrite applies. Anything
// else passes through unchanged. That includes advice the API chose for a specific case, and new
// wording after an API change. A rewrite that prints a value from `details` checks the value first.
// If the value is missing or malformed, the API sentence passes through.
import { type Phase, UPDATE_FIX } from "./errors.ts";
import { parseTtl } from "./ttl.ts";

/** Where the command's API key or delete token came from (main.ts applies the documented precedence). */
export type CredentialSource = "--api-key" | "INSTAHOST_API_KEY" | "--token" | "INSTAHOST_DELETE_TOKEN";

/** The credential a request sent: its source, "unknown" when the caller did not say, or null for none. */
export type SentCredential = CredentialSource | "unknown" | null;

/**
 * The API sentences each rewrite replaces. Each entry is keyed by an error code, for that code's
 * default `fix`, or by the name of a throw-site override (ERROR_FIX_OVERRIDES in the service). Each
 * value is a list so that, during an API wording change, a CLI can recognise both the old and the
 * new sentence. The service's contract test checks that its current sentence is in each list.
 */
export const RECOGNISED_API_FIXES = {
  persistent_requires_api_key: ["Send an API key as `Authorization: Bearer ihk_…`, or drop `persistent` and set `ttl_seconds`."],
  persistence_disabled: ["Drop `persistent` and set `ttl_seconds` instead; /v1/limits gives the longest lifetime."],
  anonymous_disabled: ["Send an API key as `Authorization: Bearer ihk_…`, because anonymous uploads are switched off."],
  anonymous_disabled_after_create: ["Create the artifact again with an API key as `Authorization: Bearer ihk_…`, because anonymous uploads are switched off."],
  create_rate_limiter_unavailable: ["Send an API key as `Authorization: Bearer ihk_…`, or retry later, when the rate limiter that anonymous uploads need is available again."],
  quota_exceeded: ["Wait until `details.resets_at`, or send an API key as `Authorization: Bearer ihk_…`, which has its own daily quota."],
  api_key_quota_exceeded: ["Wait until `details.resets_at`, when this API key's daily quota resets; see /v1/limits."],
  ttl_too_long: ["Lower `ttl_seconds` to at most `details.max_ttl_seconds`; see /v1/limits."],
  ttl_too_short: ["Raise `ttl_seconds` to at least `details.min_ttl_seconds`."],
  invalid_api_key: ["Send a valid, unrevoked API key (`ihk_…`); otherwise use the artifact's delete token to manage it, or no `Authorization` header to create anonymously."],
  forbidden: ["Use this artifact's own delete token or the API key that created it."],
  invalid_request: ["Fix or remove the field named in `details.field`; the route's schema is in /openapi.json."],
  invalid_json: ["Send the request body as valid UTF-8 JSON."],
  unsupported_media_type: ["Send the body with `Content-Type: application/json`."],
  method_not_allowed: ["Use one of the methods listed in the `Allow` header."],
  cross_site_request: ["Call the API from a script, server or the CLI, not from a web page on another site."],
  payload_too_large: ["Send a smaller request body, at most `details.limit` bytes."],
} as const satisfies Record<string, readonly string[]>;

export type RecognisedFix = keyof typeof RECOGNISED_API_FIXES;

const RULE_BY_SENTENCE: ReadonlyMap<string, RecognisedFix> = new Map(
  (Object.entries(RECOGNISED_API_FIXES) as [RecognisedFix, readonly string[]][]).flatMap(([rule, sentences]) => sentences.map((s) => [s, rule] as const)),
);

const PASS_API_KEY = "pass an API key with `--api-key` or `INSTAHOST_API_KEY`";
const CONTENT_TYPE_FIELD = "files[0].content_type";
const TTL_UNITS = [["d", 86_400], ["h", 3600], ["m", 60]] as const;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Seconds as a `--ttl` value, in the largest unit that divides them evenly (604800 becomes 7d,
 * 90 stays 90). Returns undefined unless the value is a positive safe integer that `--ttl`
 * accepts and reads back as the same number of seconds.
 */
export function ttlFlagValue(seconds: unknown): string | undefined {
  if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds < 1) return;
  const unit = TTL_UNITS.find(([, size]) => seconds % size === 0);
  const value = unit ? `${seconds / unit[1]}${unit[0]}` : String(seconds);
  try {
    const parsed = parseTtl(value);
    return parsed.kind === "ttl" && parsed.seconds === seconds ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The value if it is a real UTC time written as YYYY-MM-DDTHH:MM:SSZ, else undefined. */
export function utcTime(value: unknown): string | undefined {
  if (typeof value !== "string" || !UTC_TIME.test(value)) return;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === `${value.slice(0, -1)}.000Z` ? value : undefined;
}

const isApiKeySource = (credential: SentCredential): credential is "--api-key" | "INSTAHOST_API_KEY" =>
  credential === "--api-key" || credential === "INSTAHOST_API_KEY";
const isKnownSource = (credential: SentCredential): credential is CredentialSource => credential !== null && credential !== "unknown";

/**
 * The CLI's sentence for an API `fix`, or undefined to pass the API sentence through. Pure:
 * it reads only the API sentence, the phase, the error's `details` and the credential the
 * request sent.
 */
export function cliFix(apiFix: unknown, phase: Phase, details: Readonly<Record<string, unknown>> | undefined, credential: SentCredential): string | undefined {
  if (typeof apiFix !== "string") return;
  const rule = RULE_BY_SENTENCE.get(apiFix);
  if (rule === undefined) return;
  const create = phase === "create";
  switch (rule) {
    case "persistent_requires_api_key":
      return create ? `Remove \`--ttl never\` to use the default lifetime, or keep it and ${PASS_API_KEY}.` : undefined;
    case "persistence_disabled":
      return create ? "Remove `--ttl never` or replace it with a duration, because persistent artifacts are switched off; /v1/limits gives the longest lifetime." : undefined;
    case "anonymous_disabled":
      return create ? "Pass an API key with `--api-key` or `INSTAHOST_API_KEY`, because anonymous uploads are switched off." : undefined;
    case "anonymous_disabled_after_create":
      return phase === "publish" ? "Run the command again with an API key (`--api-key` or `INSTAHOST_API_KEY`), because anonymous uploads are switched off." : undefined;
    case "create_rate_limiter_unavailable":
      return create ? `Run the command again later, or ${PASS_API_KEY}, because the rate limiter that anonymous uploads need is unavailable.` : undefined;
    case "quota_exceeded": {
      const resetsAt = utcTime(details?.resets_at);
      return create && resetsAt ? `Wait until ${resetsAt} and run the command again, or ${PASS_API_KEY}, which has its own daily quota.` : undefined;
    }
    case "api_key_quota_exceeded": {
      const resetsAt = utcTime(details?.resets_at);
      return create && resetsAt ? `Wait until ${resetsAt}, when this API key's daily quota resets, then run the command again.` : undefined;
    }
    case "ttl_too_long": {
      const ttl = ttlFlagValue(details?.max_ttl_seconds);
      if (!create || !ttl) return;
      return credential === null
        ? `Use \`--ttl ${ttl}\` or shorter, or ${PASS_API_KEY}, which has its own limit; see /v1/limits.`
        : `Use \`--ttl ${ttl}\` or shorter; see /v1/limits.`;
    }
    case "ttl_too_short": {
      const ttl = ttlFlagValue(details?.min_ttl_seconds);
      return create && ttl ? `Use \`--ttl ${ttl}\` or longer.` : undefined;
    }
    case "invalid_api_key":
      // Only an ihk_ credential gets invalid_api_key, so it came from --api-key or INSTAHOST_API_KEY.
      if (!isApiKeySource(credential)) return;
      if (create) return `Replace the API key in \`${credential}\` with a valid, unrevoked one, or remove it to create anonymously.`;
      if (phase === "delete") return `Pass the artifact's delete token with \`--token\`, or replace the API key in \`${credential}\` with its owner's valid key.`;
      return;
    case "forbidden":
      return phase === "delete" && isKnownSource(credential)
        ? `Pass this artifact's own delete token with \`--token\`, or the API key that created it with \`--api-key\`, because the credential in \`${credential}\` cannot manage it.`
        : undefined;
    case "invalid_request":
      return create && details?.field === CONTENT_TYPE_FIELD ? "Correct `--content-type` to a lowercase media type such as `text/plain`, or leave the option out." : UPDATE_FIX;
    case "invalid_json":
    case "unsupported_media_type":
    case "method_not_allowed":
    case "cross_site_request":
      return UPDATE_FIX;
    case "payload_too_large":
      return create ? "Publish fewer files or shorten their paths, because the file list is larger than the service accepts." : undefined;
  }
}
