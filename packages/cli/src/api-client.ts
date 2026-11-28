// The API client.
// - Every request sends the CLI User-Agent (workers.dev rejects some default library agents).
// - Authorization is only ever sent to the API origin; URLs the API returns for later calls
//   (uploads_url, complete_url) must be on that origin too.
// - API calls time out after 30 s. Idempotent calls (uploads, complete, delete) are retried 3
//   times on network errors and 502/503/504 (1 s, 2 s, 4 s apart) and on 429 after Retry-After.
//   Create retries with one key and body, also on 500 and on quota refusals after a lost
//   or 5xx answer. The key stays internal to this invocation.
// - An error's `fix` is the API's, unless the CLI recognises the sentence and words it in CLI
//   terms (guidance.ts).
import { USER_AGENT, isLoopbackHost } from "./config.ts";
import { CliError, EXIT, type Phase } from "./errors.ts";
import { type CredentialSource, cliFix } from "./guidance.ts";
import { describeUrl, redact } from "./redact.ts";

export const API_TIMEOUT_MS = 30_000;
export const BACKOFF_SECONDS = [1, 2, 4] as const;
export const RETRIES = BACKOFF_SECONDS.length;
/** A Retry-After longer than this is not waited for; the 429 is reported instead. */
export const MAX_RETRY_AFTER_SECONDS = 60;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export interface ClientOptions {
  apiUrl: string;
  /**
   * Where the command's API key or delete token came from, or null when it has none. Create and
   * delete send that credential; the CLI's rewrites of the API's `fix` name its source.
   */
  credentialSource?: CredentialSource | null;
  /** Diagnostics sink (stderr in --verbose mode); every line is redacted. */
  log?: (line: string) => void;
  /** Injected in tests so retries do not wait. */
  sleep?: (seconds: number) => Promise<void>;
  fetch?: typeof fetch;
}

type JsonCallOptions = {
  body?: unknown;
  /** Bearer credential (delete token or API key); sent only to the API origin. */
  token?: string | null;
  upload?: never;
} & ({ phase: "create"; idempotencyKey: string; retry?: never } | { phase: Exclude<Phase, "create">; retry?: false });

type UploadCallOptions = {
  phase: "publish";
  token: string;
  body?: never;
  retry?: never;
  upload: { open: () => Promise<Blob>; path: string; until: number };
};

export type CallOptions = JsonCallOptions | UploadCallOptions;

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
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : err.name;
}

function createErrorGuidance(code: string): { message?: string; fix: string } | undefined {
  switch (code) {
    case "internal_error":
      return { fix: "Run the command again later, and report it with the time of the request if the error persists." };
    case "gone":
      return {
        message: "The artifact from the previous create attempt or its upload URLs have expired, or the artifact was deleted or blocked.",
        fix: "Run the command again to create a new artifact.",
      };
    case "artifact_not_pending":
      return {
        message: "The artifact from the previous create attempt is already published or failed.",
        fix: "Run the command again to create a new artifact.",
      };
  }
}

function errorDocs(value: unknown, apiOrigin: string): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.origin === apiOrigin && (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return value;
  } catch {
    // An invalid docs link can be omitted without losing the original error.
  }
}

export class ApiClient {
  readonly apiUrl: string;
  readonly #credentialSource: CredentialSource | null;
  readonly #log: (line: string) => void;
  readonly #sleep: (seconds: number) => Promise<void>;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions) {
    this.apiUrl = options.apiUrl;
    this.#credentialSource = options.credentialSource ?? null;
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
    let url: URL;
    try {
      url = new URL(pathOrUrl, this.apiUrl);
    } catch {
      throw CliError.local("unsafe_url", "The API returned an invalid URL.", EXIT.network);
    }
    if (url.origin !== this.apiUrl) {
      throw CliError.local("unsafe_url", "The API returned a URL on another origin; refusing to send credentials there.", EXIT.network, { url: describeUrl(url.href) });
    }
    if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))) {
      throw CliError.local("unsafe_url", "The API returned an unsafe URL.", EXIT.network, { url: describeUrl(url.href) });
    }
    return url;
  }

  async call<T>(method: string, pathOrUrl: string, options: CallOptions): Promise<T> {
    const url = this.resolve(pathOrUrl);
    const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const isCreate = options.phase === "create";
    const key = isCreate ? options.idempotencyKey : undefined;
    if (key) headers["idempotency-key"] = key;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const redactKey = (value: string) => key ? value.replaceAll(key, "***") : value;
    const upload = options.upload;
    const uploadEnded = () => CliError.api("upload_ended", "The upload window has closed.", 410, "publish",
      { path: upload?.path, reason: "deadline" }, {});
    const canRetryUpload = (wait: number) => !!upload && wait <= MAX_RETRY_AFTER_SECONDS && Date.now() + wait * 1000 < upload.until;
    let ambiguousCreate = false;

    for (let attempt = 0; ; attempt++) {
      const backoff = options.retry === false ? undefined : BACKOFF_SECONDS[attempt];
      if (upload && Date.now() >= upload.until) throw uploadEnded();
      const bytes = await upload?.open();
      if (bytes) headers["content-length"] = String(bytes.size);
      const started = Date.now();
      const timeout = upload ? Math.min(upload.until - started, 2_147_483_647) : API_TIMEOUT_MS;
      if (timeout <= 0) throw uploadEnded();
      let res: Response;
      let text: string;
      try {
        // The body read is guarded too: a connection cut or the timeout during the body is a
        // network failure like any other.
        res = await this.#fetch(url, { method, headers, body: bytes ?? body, redirect: "error", signal: AbortSignal.timeout(timeout) });
        text = await res.text();
      } catch (err) {
        const reason = redactKey(failureReason(err));
        this.log(`api ${method} ${url.pathname} failed (${reason})`);
        if (upload && Date.now() >= upload.until) throw uploadEnded();
        if (backoff !== undefined && (!upload || canRetryUpload(backoff))) {
          ambiguousCreate = isCreate;
          await this.#sleep(backoff);
          continue;
        }
        throw CliError.local("network_error", `Could not reach the API at ${this.apiUrl}.`, EXIT.network, { reason });
      }
      const replayed = isCreate && res.status === 201 && res.headers.get("idempotent-replayed") === "true";
      this.log(`api ${method} ${url.pathname} -> ${res.status} (${Date.now() - started} ms)${replayed ? " (replayed)" : ""}`);
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(res.ok ? text : redactKey(text)) : null;
      } catch {}
      if (res.ok) {
        if (upload) {
          const state = (parsed as { state?: unknown } | null)?.state;
          if (res.status !== 200 || (state !== "stored" && state !== "already_stored")) {
            throw CliError.local("bad_response", "The API did not confirm the file was stored.", EXIT.network, { path: upload.path }, res.status);
          }
        }
        if (parsed === null || typeof parsed !== "object") throw CliError.local("bad_response", `The API answered ${res.status} without a JSON body.`, EXIT.network, undefined, res.status);
        return parsed as T;
      }
      const envelope = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown; fix?: unknown; docs?: unknown } } | null)?.error;
      const code = typeof envelope?.code === "string" ? envelope.code : `http_${res.status}`;
      const retryAfter = retryAfterSeconds(res.headers.get("retry-after"));
      if (upload && backoff !== undefined && (res.status === 429 || res.status >= 500)) {
        const wait = retryAfter ?? backoff;
        if (canRetryUpload(wait)) {
          await this.#sleep(wait);
          continue;
        }
      }
      if (!upload && backoff !== undefined) {
        if (RETRYABLE_STATUS.has(res.status) || (isCreate && res.status === 500)) {
          ambiguousCreate = isCreate;
          await this.#sleep(backoff);
          continue;
        }
        if (res.status === 429 && code === "rate_limited") {
          const wait = retryAfter ?? backoff;
          if (wait <= MAX_RETRY_AFTER_SECONDS) {
            this.log(`api rate limited; retrying in ${wait} s`);
            await this.#sleep(wait);
            continue;
          }
        }
        // The first attempt may have taken the last quota slot before its response arrived.
        // Retry inside the replay window rather than waiting for the daily quota reset.
        if (res.status === 429 && code === "quota_exceeded" && ambiguousCreate) {
          await this.#sleep(backoff);
          continue;
        }
      }
      const override = isCreate ? createErrorGuidance(code) : undefined;
      const message = override?.message ?? (typeof envelope?.message === "string" ? envelope.message : `The API answered ${res.status}.`);
      const errorDetails = envelope?.details && typeof envelope.details === "object" ? (envelope.details as Record<string, unknown>) : undefined;
      const details = upload ? { ...errorDetails, path: upload.path } : errorDetails;
      const apiFix = envelope?.fix;
      // The CLI's own wording for an API sentence it recognises (guidance.ts), else the API's. A
      // token sent when the command has no credential of its own (the delete token that create
      // returned) has no source the CLI can name.
      const sent = options.token ? (this.#credentialSource ?? "unknown") : null;
      const fix = override?.fix ?? cliFix(apiFix, options.phase, details, sent)
        ?? (typeof apiFix === "string" && apiFix.length > 0 && apiFix.length <= 500 ? apiFix : undefined);
      const error = CliError.api(code, message, res.status, options.phase,
        retryAfter === null ? details : { ...details, retry_after_seconds: retryAfter },
        { fix, docs: errorDocs(envelope?.docs, this.apiUrl) });
      error.afterAmbiguousCreate = ambiguousCreate;
      throw error;
    }
  }
}
