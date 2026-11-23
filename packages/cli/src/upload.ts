// Uploads and publication.
// - One presigned PUT per file, body streamed from disk (fs.openAsBlob), signed headers replayed
//   exactly. A returned content-length header is checked against the file, not sent explicitly.
// - Batches of upload URLs are requested through /uploads just before use; `concurrency` PUTs run
//   at a time (default 6, 1 to 16).
// - Per file: up to 3 retries on network errors, 429 and 5xx (1 s, 2 s, 4 s). 412 means the object
//   already exists (an earlier attempt landed). A URL about to expire is replaced before use, and a
//   403 (usually an expired URL) re-issues once per file, then retries; either way the URLs of all
//   the batch's unfinished files that are about to expire are re-issued together in one /uploads
//   call. 400 BadDigest means the file changed after hashing (exit 3). Other 4xx are fatal.
// - The bytes come from the file that was hashed (same device and inode, not a symlink).
// - Presigned URLs must be https, or plain http on loopback while the API is plain-http loopback
//   (the local R2 emulator); they never get an Authorization header.
// - /complete answering 409 upload_incomplete re-uploads details.missing, then completes again, at
//   most 3 complete calls in all (the server allows MAX_COMPLETE_ATTEMPTS = 4).
import { openAsBlob } from "node:fs";
import { lstat } from "node:fs/promises";
import { type ApiClient, BACKOFF_SECONDS, RETRIES } from "./api-client.ts";
import { isLoopbackHost } from "./config.ts";
import { CliError, EXIT, inputError } from "./errors.ts";
import { describeUrl } from "./redact.ts";

export interface UploadFile {
  path: string;
  absPath: string;
  size: number;
  md5: string;
  /** Identity of the file that was hashed; the upload refuses a different file at the same path. */
  dev?: number;
  ino?: number;
}

export interface Instruction {
  path: string;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
}

export interface InstructionBatch {
  expires_at: string;
  files: Instruction[];
}

export interface AuthorizedArtifact {
  id: string;
  type: "file" | "site";
  access: "public" | "unlisted" | "private";
  status: string;
  url: string;
  created_at: string;
  expires_at: string | null;
  published_at: string | null;
  file_count: number;
  total_bytes: number;
  owner?: string | null;
}

export interface CreateResponse {
  artifact: AuthorizedArtifact;
  delete_token: string;
  access_token?: string;
  access_url?: string;
  upload: InstructionBatch & { batch_size: number; remaining: number; uploads_url: string; complete_url: string };
}

export interface PublishSession {
  client: ApiClient;
  created: CreateResponse;
  /** In manifest order (the order sent at create). */
  files: UploadFile[];
  /**
   * The API key that created the artifact, if any. It manages the artifact like the delete token,
   * and /uploads and /complete then count against the key's rate limits (300 a minute per IP and per
   * key) instead of the anonymous 30 a minute per IP that every other bearer gets.
   */
  apiKey?: string | null;
  concurrency: number;
  onProgress?: (done: number, total: number) => void;
  /** Injected in tests. */
  fetch?: typeof fetch;
  /** URLs with less life left than this are replaced before use (default MIN_URL_LIFE_MS). */
  minUrlLifeMs?: number;
}

export const MAX_COMPLETE_CALLS = 3;
export const DEFAULT_CONCURRENCY = 6;
/** Re-issue requests arriving within this window share one /uploads call. */
const REFRESH_GATHER_MS = 25;
/** URLs with less life left than this are re-issued before use rather than tried. */
const MIN_URL_LIFE_MS = 5_000;

interface Cached {
  instruction: Instruction;
  expiresAt: number;
  issuedAt: number;
  /** Which remember() call stored it: a refresh is needed only while a file still has the URL it saw. */
  generation: number;
}

/** The S3 error code in an XML error body, for diagnostics. */
function s3Code(body: string): string | null {
  return /<Code>([^<]{1,64})<\/Code>/.exec(body)?.[1] ?? null;
}

/**
 * Presigned URLs must be https. Plain http is accepted only for the local R2 emulator: a loopback
 * host, and only while the API itself is plain-http loopback (a local development server).
 */
export function checkUploadUrl(raw: string, apiUrl: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError("unsafe_url", "The API returned an invalid upload URL.", EXIT.network);
  }
  const api = new URL(apiUrl);
  const localHttp = url.protocol === "http:" && isLoopbackHost(url.hostname) && api.protocol === "http:" && isLoopbackHost(api.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new CliError("unsafe_url", "The API returned an upload URL that is not https.", EXIT.network, { url: describeUrl(raw) });
  }
  return url;
}

/** The fields this module reads from an instruction batch; anything else is a broken server. */
export function checkBatch(batch: unknown, where: string): asserts batch is InstructionBatch {
  const b = batch as Partial<InstructionBatch> | null | undefined;
  const ok =
    !!b &&
    typeof b.expires_at === "string" &&
    Array.isArray(b.files) &&
    b.files.every((f) => f && typeof f.path === "string" && typeof f.url === "string" && f.method === "PUT" && f.headers !== null && typeof f.headers === "object");
  if (!ok) throw new CliError("bad_response", `The API's answer to ${where} has no valid upload instructions.`, EXIT.network);
}

/** The fields read from a create answer (batch_size must be at least 1, or batching never ends). */
export function checkCreated(created: unknown): asserts created is CreateResponse {
  const c = created as Partial<CreateResponse> | null | undefined;
  checkBatch(c?.upload, "create");
  const u = c?.upload as CreateResponse["upload"];
  const ok =
    typeof c?.artifact?.id === "string" &&
    typeof c.delete_token === "string" &&
    Number.isInteger(u.batch_size) &&
    u.batch_size >= 1 &&
    typeof u.uploads_url === "string" &&
    typeof u.complete_url === "string";
  if (!ok) throw new CliError("bad_response", "The API's answer to create is incomplete.", EXIT.network);
}

/** The fields read from a published artifact. */
export function checkArtifact(artifact: unknown, where: string): asserts artifact is AuthorizedArtifact {
  const a = artifact as Partial<AuthorizedArtifact> | null | undefined;
  if (!a || typeof a.id !== "string" || typeof a.url !== "string") throw new CliError("bad_response", `The API's answer to ${where} has no artifact.`, EXIT.network);
}

class Uploader {
  readonly #s: PublishSession;
  readonly #fetch: typeof fetch;
  readonly #minLifeMs: number;
  readonly #cache = new Map<string, Cached>();
  readonly #done = new Set<string>();
  #generation = 0;
  /** Paths waiting for the next re-issue round, and that round. */
  readonly #pending = new Set<string>();
  #round: Promise<void> | null = null;
  #progress = 0;

  constructor(session: PublishSession) {
    this.#s = session;
    this.#fetch = session.fetch ?? fetch;
    this.#minLifeMs = session.minUrlLifeMs ?? MIN_URL_LIFE_MS;
    this.remember(session.created.upload);
  }

  remember(batch: InstructionBatch): void {
    const expiresAt = Date.parse(batch.expires_at);
    const generation = ++this.#generation;
    const issuedAt = Date.now();
    for (const instruction of batch.files) {
      this.#cache.set(instruction.path, { instruction, expiresAt: Number.isNaN(expiresAt) ? 0 : expiresAt, issuedAt, generation });
    }
  }

  get #token(): string {
    return manageToken(this.#s);
  }

  /**
   * True when a file has no URL, or its URL aged to under the minimum life. A URL that was already
   * that short when issued (the server caps URLs at the end of the upload window) is used as it is:
   * a new one would be no longer.
   */
  #stale(path: string, now = Date.now()): boolean {
    const c = this.#cache.get(path);
    return !c || (c.expiresAt - now < this.#minLifeMs && c.expiresAt - c.issuedAt >= this.#minLifeMs);
  }

  async issue(paths: string[]): Promise<void> {
    const size = this.#s.created.upload.batch_size;
    for (let i = 0; i < paths.length; i += size) {
      const r = await this.#s.client.call<{ upload: InstructionBatch }>("POST", this.#s.created.upload.uploads_url, {
        body: { paths: paths.slice(i, i + size) },
        token: this.#token,
        idempotent: true,
        phase: "publish",
      });
      checkBatch(r?.upload, "/uploads");
      this.remember(r.upload);
    }
  }

  /**
   * Gets a new URL for `path` (each file may re-issue once on 403). Requests that
   * arrive within REFRESH_GATHER_MS share one /uploads call, together with every other unfinished
   * file of the batch whose URL is about to expire; a caller whose URL is still the one it saw
   * (generation) after a round joins the next, so later waves of expiry are covered too. The
   * server caps issuance at MAX_URL_ISSUES_PER_FILE, which bounds this.
   */
  async #refresh(batch: UploadFile[], path: string, seenGeneration: number): Promise<void> {
    while ((this.#cache.get(path)?.generation ?? 0) <= seenGeneration) {
      this.#pending.add(path);
      this.#round ??= this.#runRound(batch);
      await this.#round;
    }
  }

  async #runRound(batch: UploadFile[]): Promise<void> {
    try {
      await new Promise((resolve) => setTimeout(resolve, REFRESH_GATHER_MS));
      const now = Date.now();
      const paths = batch.filter((f) => !this.#done.has(f.path) && (this.#pending.has(f.path) || this.#stale(f.path, now))).map((f) => f.path);
      this.#pending.clear();
      if (paths.length) await this.issue(paths);
    } finally {
      this.#round = null;
    }
  }

  async uploadAll(files: UploadFile[]): Promise<void> {
    const size = this.#s.created.upload.batch_size;
    for (let i = 0; i < files.length; i += size) {
      const batch = files.slice(i, i + size);
      const now = Date.now();
      const stale = batch.filter((f) => this.#stale(f.path, now)).map((f) => f.path);
      if (stale.length) await this.issue(stale);
      await this.#pool(batch);
    }
  }

  async #pool(batch: UploadFile[]): Promise<void> {
    let next = 0;
    let stopped = false;
    const worker = async () => {
      while (next < batch.length && !stopped) {
        const file = batch[next++] as UploadFile;
        try {
          await this.#uploadOne(file, batch);
        } catch (err) {
          stopped = true; // the other workers finish their current file and stop
          throw err;
        }
      }
    };
    const workers = Array.from({ length: Math.min(this.#s.concurrency, batch.length) }, worker);
    const results = await Promise.allSettled(workers);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }

  /** The file's bytes, from the same file that was hashed: never through a symlink swapped in since. */
  async #body(file: UploadFile): Promise<Blob> {
    const changed = () => inputError("file_changed", `${file.path} changed since it was hashed; try again.`, { path: file.path });
    let info;
    try {
      info = await lstat(file.absPath);
    } catch {
      throw inputError("unreadable_file", `${file.path} can no longer be read.`, { path: file.path });
    }
    if (!info.isFile() || info.size !== file.size || (file.ino !== undefined && (info.ino !== file.ino || info.dev !== file.dev))) throw changed();
    const body = await openAsBlob(file.absPath).catch(() => {
      throw inputError("unreadable_file", `${file.path} can no longer be read.`, { path: file.path });
    });
    if (body.size !== file.size) throw changed();
    return body;
  }

  async #uploadOne(file: UploadFile, batch: UploadFile[]): Promise<void> {
    let reissued = false;
    let refreshedBeforeUse = false;
    let retries = 0;
    for (;;) {
      const cached = this.#cache.get(file.path);
      if (!cached) throw new CliError("bad_response", `The API returned no upload URL for ${file.path}.`, EXIT.network, { path: file.path });
      // A URL about to expire is replaced before use (once: near the end of the upload window the
      // server only issues short-lived URLs, which are then used as they are).
      if (!refreshedBeforeUse && this.#stale(file.path)) {
        refreshedBeforeUse = true;
        await this.#refresh(batch, file.path, cached.generation);
        continue;
      }
      const { instruction } = cached;
      const url = checkUploadUrl(instruction.url, this.#s.client.apiUrl);
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(instruction.headers)) {
        if (name.toLowerCase() === "content-length") {
          if (Number(value) !== file.size) throw inputError("file_changed", `${file.path} changed size since it was hashed; try again.`, { path: file.path });
          continue; // fetch sends the length of the body itself
        }
        headers[name] = value;
      }
      const body = await this.#body(file);

      let status: number;
      let detail: string | null = null;
      try {
        const res = await this.#fetch(url, { method: instruction.method, headers, body, redirect: "error" });
        status = res.status;
        detail = status >= 400 ? s3Code(await res.text()) : (await res.arrayBuffer(), null);
      } catch (err) {
        status = 0;
        detail = err instanceof Error ? ((err.cause as { code?: string } | undefined)?.code ?? err.name) : "unknown";
      }
      this.#s.client.log(`put ${file.path} -> ${status || "network error"}${detail ? ` (${detail})` : ""}`);

      if (status === 200 || status === 412) {
        this.#done.add(file.path);
        this.#s.onProgress?.(++this.#progress, this.#s.files.length);
        return;
      }
      if (status === 403 && !reissued) {
        reissued = true;
        await this.#refresh(batch, file.path, cached.generation);
        continue;
      }
      if ((status === 0 || status === 429 || status >= 500) && retries < RETRIES) {
        await this.#s.client.sleep(BACKOFF_SECONDS[retries++] ?? 4);
        continue;
      }
      // The signed Content-MD5 no longer matches: the file changed (at the same size) after hashing.
      if (status === 400 && (detail === "BadDigest" || detail === "InvalidDigest")) {
        throw inputError("file_changed", `${file.path} changed since it was hashed (storage refused its checksum); try again.`, { path: file.path });
      }
      const reason = status === 0 ? `network error (${detail})` : `HTTP ${status}${detail ? ` ${detail}` : ""}`;
      throw new CliError("upload_failed", `Uploading ${file.path} failed: ${reason}.`, EXIT.network, { path: file.path, status: status || null, s3_code: status ? detail : null });
    }
  }

  /** Re-uploads paths the server reported missing (their URLs are re-issued if stale). */
  async reupload(paths: string[]): Promise<void> {
    const byPath = new Map(this.#s.files.map((f) => [f.path, f]));
    const files = paths.map((p) => byPath.get(p)).filter((f): f is UploadFile => f !== undefined);
    for (const f of files) this.#done.delete(f.path);
    this.#progress = Math.max(0, this.#progress - files.length);
    await this.uploadAll(files);
  }
}

/**
 * Runs the steps after create; any failure carries the created artifact's id, URL and delete token,
 * because the artifact may exist (an answer can be lost after the server published it).
 */
export async function afterCreate<T>(created: CreateResponse, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    const error = err instanceof CliError ? err : new CliError("internal_error", `Unexpected error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`, EXIT.internal);
    error.artifact = { id: created.artifact.id, url: created.artifact.url, delete_token: created.delete_token, access_url: created.access_url ?? null };
    throw error;
  }
}

/** The credential for /uploads and /complete: the creating API key, else the delete token. */
export function manageToken(session: Pick<PublishSession, "apiKey" | "created">): string {
  return session.apiKey ?? session.created.delete_token;
}

/** Uploads every file and publishes the artifact; returns the published artifact. */
export async function uploadAndComplete(session: PublishSession): Promise<AuthorizedArtifact> {
  const uploader = new Uploader(session);
  await uploader.uploadAll(session.files);
  for (let call = 1; ; call++) {
    try {
      const r = await session.client.call<{ artifact: AuthorizedArtifact }>("POST", session.created.upload.complete_url, {
        token: manageToken(session),
        idempotent: true,
        phase: "publish",
      });
      checkArtifact(r?.artifact, "complete");
      return r.artifact;
    } catch (err) {
      if (!(err instanceof CliError) || err.code !== "upload_incomplete" || call >= MAX_COMPLETE_CALLS) throw err;
      const missing = Array.isArray(err.details?.missing) ? (err.details.missing as unknown[]).filter((p): p is string => typeof p === "string") : [];
      session.client.log(`complete: ${String(err.details?.missing_count ?? missing.length)} file(s) missing; uploading them again`);
      await uploader.reupload(missing.length ? missing : session.files.map((f) => f.path));
    }
  }
}
