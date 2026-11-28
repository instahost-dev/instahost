// Output.
// --json: exactly one JSON document on stdout, on success and on failure; nothing on stderr unless
// --verbose. Human mode: the result on stdout; skipped files, warnings, errors and progress (only
// when stderr is a TTY) on stderr. No colour is used, so NO_COLOR needs no handling.
import type { CliError } from "./errors.ts";
import { redact, redactCredentials, redactUploadCredential } from "./redact.ts";
import type { Skipped } from "./walk.ts";

export interface Warning {
  code: string;
  message: string;
  paths?: string[];
}

export interface PublishedDocument {
  ok: true;
  id: string;
  type: "file" | "site";
  access: string;
  url: string;
  expires_at: string | null;
  delete_token: string;
  access_token: string | null;
  access_url: string | null;
  file_count: number;
  total_bytes: number;
  skipped: Skipped[];
  warnings: Warning[];
}

export interface DeletedDocument {
  ok: true;
  id: string;
  status: string;
  deleted_at: string | null;
}

export interface PublishPreviewDocument {
  ok: true;
  dry_run: true;
  type: "site";
  files: { path: string; size: number }[];
  file_count: number;
  total_bytes: number;
  skipped: Skipped[];
  warnings: Warning[];
}

export type ResultDocument = PublishedDocument | DeletedDocument | PublishPreviewDocument;

export interface ErrorDocument {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown>; fix: string; docs?: string; exit_code: number };
}

const ARTIFACT_FIX = "The artifact in `details.artifact` may exist: delete it with its `delete_token`.";

export interface Streams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stderrIsTty: boolean;
}

/** Redacts every string inside a JSON-like value (never the serialised text, which it could corrupt). */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactUploadCredential(k), redactValue(v)]));
  return value;
}

/**
 * The --json failure document. An artifact created before the failure keeps its usable delete
 * token and access URL for recovery.
 */
export function errorDocument(err: CliError): ErrorDocument {
  let details = err.details && Object.keys(err.details).length ? (redactValue(err.details) as Record<string, unknown>) : undefined;
  if (err.artifact) {
    const a = err.artifact;
    details = { ...details, artifact: {
      id: redactUploadCredential(a.id),
      url: redactUploadCredential(a.url),
      delete_token: redactUploadCredential(a.delete_token),
      access_url: a.access_url === null ? null : redactUploadCredential(a.access_url),
    } };
  }
  const fix = redactCredentials(err.fix) + (err.artifact ? ` ${ARTIFACT_FIX}` : "");
  return {
    ok: false,
    error: {
      code: redactUploadCredential(err.code),
      message: redact(err.message),
      ...(details ? { details } : {}),
      fix,
      ...(err.docs ? { docs: redactCredentials(err.docs) } : {}),
      exit_code: err.exitCode,
    },
  };
}

/**
 * The delete command printed in human output. It names the scoped package on purpose: most users run
 * the CLI through npx and have no `instahost` on PATH, and the obvious fix, `npx instahost`, would run
 * the unrelated unscoped npm package and hand it the delete token.
 */
export const DELETE_COMMAND = "npx -y @instahost/cli delete";

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
/** Text for a terminal: control, line-separator and bidi characters become visible escapes. */
export function terminalSafe(text: string): string {
  return text.replace(CONTROL, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function printJson(streams: Streams, doc: unknown): void {
  streams.stdout(`${JSON.stringify(doc)}\n`);
}

const SKIP_LABEL: Record<Skipped["reason"], string> = {
  sensitive: "looks like a credential or VCS data",
  os_metadata: "operating-system metadata",
  dotfile: "dotfile (use --include-dotfiles)",
  symlink: "symbolic link (never followed)",
  special: "not a regular file",
};

// Human output escapes control characters: file names and server strings are untrusted and could
// otherwise carry terminal escape sequences (clipboard writes, hidden or rewritten lines).
export function printHuman(streams: Streams, doc: ResultDocument): void {
  const t = terminalSafe;
  if ("skipped" in doc) {
    for (const s of doc.skipped) streams.stderr(`skipped  ${t(s.path)}  (${SKIP_LABEL[s.reason]})\n`);
    for (const w of doc.warnings) streams.stderr(`warning  ${t(w.message)}${w.paths?.length ? `: ${t(w.paths.join(", "))}` : ""}\n`);
  }
  if ("dry_run" in doc) {
    const lines = [`Dry run: would publish ${doc.file_count} file(s) (${doc.total_bytes} bytes). Nothing uploaded.`];
    for (const file of doc.files) lines.push(`  ${t(file.path)}  (${file.size} bytes)`);
    streams.stdout(`${lines.join("\n")}\n`);
    return;
  }
  if ("delete_token" in doc) {
    const lines = [`URL      ${t(doc.url)}`];
    if (doc.access_url) lines.push(`Access   ${t(doc.access_url)}`);
    lines.push(`Expires  ${doc.expires_at ?? "never"}`, `Delete   ${DELETE_COMMAND} ${doc.id} --token ${t(doc.delete_token)}`);
    streams.stdout(`${lines.join("\n")}\n`);
    return;
  }
  streams.stdout(`${doc.status === "blocked" ? "Blocked (taken down by the operator)" : "Deleted"}  ${t(doc.id)}\n`);
}

export function printHumanError(streams: Streams, err: CliError): void {
  const t = (text: string) => terminalSafe(redact(text));
  const lines = [`instahost: ${t(err.message)}`];
  const details = err.details ?? {};
  const paths = Array.isArray(details.paths) ? (details.paths as unknown[]) : [];
  for (const p of paths.slice(0, 20)) {
    if (typeof p === "string") lines.push(`  ${t(p)}`);
    else if (p && typeof p === "object" && "path" in p) lines.push(`  ${t(String((p as { path: unknown }).path))}${"reason" in p ? `  (${t(String((p as { reason: unknown }).reason))})` : ""}`);
  }
  if (typeof details.reason === "string" && !paths.length && !err.message.includes(details.reason)) lines[0] += ` (${t(details.reason)})`;
  lines.push(`  fix:  ${terminalSafe(redactCredentials(err.fix))}`);
  if (err.docs) lines.push(`  docs: ${terminalSafe(redactCredentials(err.docs))}`);
  if (err.artifact) {
    const a = err.artifact;
    lines.push(`instahost: the artifact may exist (${t(a.url)}); delete it with: ${DELETE_COMMAND} ${t(a.id)} --token ${terminalSafe(redactUploadCredential(a.delete_token))}`);
  }
  streams.stderr(`${lines.join("\n")}\n`);
}
