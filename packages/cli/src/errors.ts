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

const REPORT_URL = "https://github.com/instahost-dev/instahost/issues";
/** For an API error that means this CLI sent a request the API cannot read: a newer CLI may fix it. */
export const UPDATE_FIX = "Try the latest CLI (`npx -y @instahost/cli@latest`), then report the error at " + REPORT_URL + " if it persists.";
export const LOCAL_FIX = {
  usage: "Correct the command using the options listed by `npx -y @instahost/cli --help`.",
  internal_error: `Run the command again, then report the error at ${REPORT_URL} with the CLI version if it persists.`,
  file_not_found: "Check the path, then run the command again.",
  not_a_file: "Pass a regular file to `share`, or use `publish` for a directory.",
  not_a_directory: "Pass a directory to `publish`, or share a single file with `share`.",
  unreadable_file: "Make the file readable, then run the command again.",
  unreadable_directory: "Make the directory readable, then run the command again.",
  symlink_refused: "Pass the real file instead of a symbolic link.",
  sensitive_file: "Leave this file out, because its name or location looks like a credential or VCS data.",
  invalid_path: "Rename the files in `details.paths`, or pass `--name` when sharing a single file.",
  duplicate_path: "Rename one of the files in `details.paths` so that the two names differ.",
  missing_index: "Add an `index.html` at the root of the directory, or share a single file with `share`.",
  empty_directory: "Publish the directory that holds the built site and its `index.html`.",
  walk_too_many_files: "Publish a smaller directory, such as the build output only.",
  file_changed: "Run the command again once the file is no longer changing.",
  network_error: "Check the network connection, then run the command again.",
  upload_failed: "Run the command again later.",
  bad_response: UPDATE_FIX,
  unsafe_url: UPDATE_FIX,
} as const;

const API_FALLBACK_FIX: Record<Exclude<ExitCode, 0>, string> = {
  [EXIT.internal]: LOCAL_FIX.internal_error,
  [EXIT.usage]: LOCAL_FIX.usage,
  [EXIT.localInput]: "Check the local input described in the message, then run the command again.",
  [EXIT.auth]: "Check the API key or delete token, then run the command again.",
  [EXIT.rejected]: "Change the request as the message says, then run the command again.",
  [EXIT.rateLimited]: "Wait the number of seconds in `details.retry_after_seconds` if set, then run the command again.",
  [EXIT.network]: LOCAL_FIX.upload_failed,
  [EXIT.publishFailed]: "Run the command again to publish a new artifact.",
  [EXIT.notFound]: "Check the artifact id or URL.",
};

type LocalErrorCode = keyof typeof LOCAL_FIX;
type FailureExitCode = Exclude<ExitCode, 0>;

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
  readonly exitCode: FailureExitCode;
  readonly details: Record<string, unknown> | undefined;
  readonly fix: string;
  readonly docs: string | undefined;
  /** HTTP status of the API answer behind this error, if any. */
  readonly status: number | undefined;
  /** Set when the failure came after create: the artifact may exist (it may even be published). */
  artifact: CreatedArtifact | undefined;
  /** A previous create attempt with the same key may have stored the artifact. */
  afterAmbiguousCreate = false;
  private constructor(code: string, message: string, exitCode: FailureExitCode, fix: string, details?: Record<string, unknown>, status?: number, docs?: string) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
    this.fix = fix;
    this.docs = docs;
    this.status = status;
  }

  static local(code: LocalErrorCode, message: string, exitCode: FailureExitCode, details?: Record<string, unknown>, status?: number): CliError {
    return new CliError(code, message, exitCode, LOCAL_FIX[code], details, status);
  }

  static api(code: string, message: string, status: number, phase: Phase, details: Record<string, unknown> | undefined, guidance: { fix?: string; docs?: string }): CliError {
    const exitCode = apiFailureExitCode(status, code, phase);
    const fix = status === 429 && code === "rate_limited" ? API_FALLBACK_FIX[EXIT.rateLimited] : guidance.fix;
    return new CliError(code, message, exitCode, fix ?? API_FALLBACK_FIX[exitCode], details, status, guidance.docs);
  }
}

export const usageError = (message: string, details?: Record<string, unknown>) => CliError.local("usage", message, EXIT.usage, details);
export const inputError = (code: LocalErrorCode, message: string, details?: Record<string, unknown>) => CliError.local(code, message, EXIT.localInput, details);

/** Where an API error happened: the publication steps (uploads, PUT, complete) map 409/410/422 to 8. */
export type Phase = "create" | "publish" | "delete";

/** API error codes that end a publication (exit 8) wherever they appear in the publish phase. */
const PUBLICATION_CODES = new Set(["upload_mismatch", "upload_incomplete", "artifact_failed", "artifact_not_pending", "upload_url_limit", "complete_attempt_limit", "gone"]);

/**
 * Exit code for an error envelope from the API. Order matters: 429 and 401/403 win over the phase,
 * 404 is not found, 5xx is a server failure.
 */
function apiFailureExitCode(status: number, code: string, phase: Phase): FailureExitCode {
  if (status === 429) return EXIT.rateLimited;
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 404) return EXIT.notFound;
  if (status >= 500) return EXIT.network;
  if (phase === "publish" && (PUBLICATION_CODES.has(code) || status === 409 || status === 410 || status === 422)) return EXIT.publishFailed;
  if (status >= 400) return EXIT.rejected;
  return EXIT.internal;
}

export const exitCodeForApiError: (status: number, code: string, phase: Phase) => ExitCode = apiFailureExitCode;
