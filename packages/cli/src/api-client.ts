// The API client.
// - Every request sends the CLI User-Agent (workers.dev rejects some default library agents).
// - Authorization is only ever sent to the API origin; URLs the API returns for later calls
//   (uploads_url, complete_url) must be on that origin too.
// - API calls time out after 30 s. Idempotent calls (uploads, complete, delete) are retried 3
//   times on network errors and 502/503/504 (1 s, 2 s, 4 s apart) and on 429 after Retry-After.
//   Create is never retried automatically.
import { USER_AGENT } from "./config.ts";
import { CliError, EXIT, type Phase, exitCodeForApiError } from "./errors.ts";
import { describeUrl, redact } from "./redact.ts";

export const API_TIMEOUT_MS = 30_000;
export const RETRIES = 3;
export const BACKOFF_SECONDS = [1, 2, 4] as const;
/** A Retry-After longer than this is not waited for; the 429 is reported instead. */
export const MAX_RETRY_AFTER_SECONDS = 60;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export interface ClientOptions {
  apiUrl: string;
  /** Diagnostics sink (stderr in --verbose mode); every line is redacted. */
  log?: (line: string) => void;
  /** Injected in tests so retries do not wait. */
  sleep?: (seconds: number) => Promise<void>;
  fetch?: typeof fetch;
}

export interface CallOptions {
  body?: unknown;
  /** Bearer credential (delete token or API key); sent only to the API origin. */
  token?: string | null;
  idempotent: boolean;
  phase: Phase;
}

export const realSleep = (seconds: number) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));

const IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/** Retry-After in seconds (delta-seconds or an IMF-fixdate, RFC 9110), or null for anything else. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | null {
  if (header === null) return null;
  const value = header.trim();
  if (/^\d{1,9}$/.test(value)) return Number(value);
  if (!IMF_FIXDATE.test(value)) return null;
  return Math.max(0, Math.ceil((Date.parse(value) - now) / 1000));
}

/** A short reason for a failed request or body read: "timeout" or the socket error code. */
function failureReason(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  if (err.name === "TimeoutError") return "timeout";
  return (err.cause as { code?: string } | undefined)?.code ?? err.name;
}

export class ApiClient {
  readonly apiUrl: string;
  readonly #log: (line: string) => void;
  readonly #sleep: (seconds: number) => Promise<void>;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    this.apiUrl = options.apiUrl;
    this.#log = options.log ?? (() => {});
    this.#sleep = options.sleep ?? realSleep;
    this.#fetch = options.fetch ?? fetch;
  }

  log(line: string): void {
    this.#log(redact(line));
  }

  sleep(seconds: number): Promise<void> {
    return this.#sleep(seconds);
  }

  /** Resolves a path or an absolute URL the API returned; refuses any other origin. */
  resolve(pathOrUrl: string): URL {
    const url = new URL(pathOrUrl, this.apiUrl);
    if (url.origin !== this.apiUrl) {
      throw new CliError("unsafe_url", "The API returned a URL on another origin; refusing to send credentials there.", EXIT.network, { url: describeUrl(url.href) });
    }
    return url;
  }

  async call<T>(method: string, pathOrUrl: string, options: CallOptions): Promise<T> {
    const url = this.resolve(pathOrUrl);
    const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const attempts = options.idempotent ? RETRIES + 1 : 1;

    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      let res: Response;
      let text: string;
      try {
        // The body read is guarded too: a connection cut or the timeout during the body is a
        // network failure like any other (retried when the call is idempotent).
        res = await this.#fetch(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(API_TIMEOUT_MS) });
        text = await res.text();
      } catch (err) {
        const reason = failureReason(err);
        this.log(`api ${method} ${url.pathname} failed (${reason})`);
        if (attempt < attempts) {
          await this.#sleep(BACKOFF_SECONDS[attempt - 1] ?? 4);
          continue;
        }
        throw new CliError("network_error", `Could not reach the API at ${this.apiUrl}.`, EXIT.network, { reason });
      }
      this.log(`api ${method} ${url.pathname} -> ${res.status} (${Date.now() - started} ms)`);
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {}
      if (res.ok) {
        if (parsed === null || typeof parsed !== "object") throw new CliError("bad_response", `The API answered ${res.status} without a JSON body.`, EXIT.network, undefined, res.status);
        return parsed as T;
      }
      const envelope = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
      const code = typeof envelope?.code === "string" ? envelope.code : `http_${res.status}`;
      if (attempt < attempts) {
        if (RETRYABLE_STATUS.has(res.status)) {
          await this.#sleep(BACKOFF_SECONDS[attempt - 1] ?? 4);
          continue;
        }
        if (res.status === 429 && code === "rate_limited") {
          const wait = retryAfterSeconds(res.headers.get("retry-after")) ?? BACKOFF_SECONDS[attempt - 1] ?? 4;
          if (wait <= MAX_RETRY_AFTER_SECONDS) {
            this.log(`api rate limited; retrying in ${wait} s`);
            await this.#sleep(wait);
            continue;
          }
        }
      }
      const message = typeof envelope?.message === "string" ? envelope.message : `The API answered ${res.status}.`;
      const details = envelope?.details && typeof envelope.details === "object" ? (envelope.details as Record<string, unknown>) : undefined;
      const retryAfter = retryAfterSeconds(res.headers.get("retry-after"));
      throw new CliError(code, redact(message), exitCodeForApiError(res.status, code, options.phase), retryAfter === null ? details : { ...details, retry_after_seconds: retryAfter }, res.status);
    }
  }
}
