// CLI errors and exit codes.
// Every failure becomes a CliError with a stable code, so --json can always print one document.

export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  localInput: 3,
  auth: 4,
  rejected: 5,
  rateLimited: 6,
  network: 7,
  publishFailed: 8,
  notFound: 9,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An artifact that was created before a later step failed: the caller can still delete it. */
export interface CreatedArtifact {
  id: string;
  url: string;
  delete_token: string;
  access_url: string | null;
}

export class CliError extends Error {
  override name = "CliError";
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly details: Record<string, unknown> | undefined;
  /** HTTP status of the API answer behind this error, if any. */
  readonly status: number | undefined;
  /** Set when the failure came after create: the artifact may exist (it may even be published). */
  artifact: CreatedArtifact | undefined;
  constructor(code: string, message: string, exitCode: ExitCode, details?: Record<string, unknown>, status?: number) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
    this.status = status;
  }
}

export const usageError = (message: string, details?: Record<string, unknown>) => new CliError("usage", message, EXIT.usage, details);
export const inputError = (code: string, message: string, details?: Record<string, unknown>) => new CliError(code, message, EXIT.localInput, details);

/** Where an API error happened: the publication steps (uploads, PUT, complete) map 409/410/422 to 8. */
export type Phase = "create" | "publish" | "delete";

/** API error codes that end a publication (exit 8) wherever they appear in the publish phase. */
const PUBLICATION_CODES = new Set(["upload_mismatch", "upload_incomplete", "artifact_failed", "artifact_not_pending", "upload_url_limit", "complete_attempt_limit", "gone"]);

/**
 * Exit code for an error envelope from the API. Order matters: 429 and 401/403 win over the phase,
 * 404 is not found, 5xx is a server failure.
 */
export function exitCodeForApiError(status: number, code: string, phase: Phase): ExitCode {
  if (status === 429) return EXIT.rateLimited;
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 404) return EXIT.notFound;
  if (status >= 500) return EXIT.network;
  if (phase === "publish" && (PUBLICATION_CODES.has(code) || status === 409 || status === 410 || status === 422)) return EXIT.publishFailed;
  if (status >= 400) return EXIT.rejected;
  return EXIT.internal;
}
