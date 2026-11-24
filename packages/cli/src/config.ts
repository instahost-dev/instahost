// CLI configuration.
// Precedence: flag, then environment, then DEFAULT_API_URL, the production API origin. Empty
// means the CLI asks for an API URL.
import { usageError } from "./errors.ts";

export const VERSION = "0.1.2";
/**
 * The production API origin. The service's deploy preflight refuses to deploy an API origin that
 * differs from this value in the CLI version it pins, so changing the API domain needs a CLI release
 * first. Keep it on one line.
 */
export const DEFAULT_API_URL = "https://instahost.dev";

export const USER_AGENT = `instahost-cli/${VERSION} (node/${process.versions.node})`;

/**
 * Loopback hosts: the only ones http:// is accepted for. `localhost` itself, IPv4
 * 127.0.0.0/8 and [::1]. Other `*.localhost` names are refused: Node resolves them through the
 * system resolver, which may ask DNS before mapping them to loopback.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(h) || h === "::1";
}

/**
 * Parses and checks an API base URL: https, or http on a loopback host; no credentials, query or
 * fragment; an optional trailing slash. Returns the origin (the API serves /v1 at its root).
 */
export function parseApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw usageError(`The API URL is not a valid URL: ${JSON.stringify(raw)}.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw usageError("The API URL must use https:// (http:// is accepted only for localhost).", { api_url: url.origin });
  }
  if (url.username || url.password || url.search || url.hash) throw usageError("The API URL must not contain credentials, a query or a fragment.");
  if (url.pathname !== "/" && url.pathname !== "") throw usageError("The API URL is the service origin, for example https://instahost.dev (no path).", { api_url: url.origin });
  return url.origin;
}

export interface Settings {
  apiUrl: string;
  apiKey: string | null;
}

export function resolveApiUrl(flag: string | undefined, env: NodeJS.ProcessEnv, defaultUrl: string = DEFAULT_API_URL): string {
  const raw = flag ?? (env.INSTAHOST_API_URL || undefined) ?? (defaultUrl || undefined);
  if (!raw) throw usageError("No API URL: pass --api-url <url> or set INSTAHOST_API_URL.");
  return parseApiUrl(raw);
}

const API_KEY = /^ihk_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/;
const DELETE_TOKEN = /^ihd_[A-Za-z0-9_-]{43}$/;

export function resolveApiKey(flag: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const raw = flag ?? (env.INSTAHOST_API_KEY || undefined);
  if (raw === undefined) return null;
  if (!API_KEY.test(raw)) throw usageError("The API key is malformed (expected ihk_<id>_<secret>).");
  return raw;
}

export function resolveDeleteToken(flag: string | undefined, env: NodeJS.ProcessEnv): string | null {
  const raw = flag ?? (env.INSTAHOST_DELETE_TOKEN || undefined);
  if (raw === undefined) return null;
  if (!DELETE_TOKEN.test(raw)) throw usageError("The delete token is malformed (expected ihd_<43 characters>).");
  return raw;
}
