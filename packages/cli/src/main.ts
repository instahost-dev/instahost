// CLI entry. Never interactive.
// --json prints exactly one JSON document on stdout for every outcome: success, argument errors,
// API errors and unexpected exceptions alike.
import { parseArgs } from "node:util";
import { ApiClient } from "./api-client.ts";
import { VERSION, resolveApiKey, resolveApiUrl, resolveDeleteToken } from "./config.ts";
import { CliError, EXIT, usageError } from "./errors.ts";
import { type ResultDocument, type Streams, errorDocument, printHuman, printHumanError, printJson } from "./output.ts";
import { redact } from "./redact.ts";
import { type Lifetime, parseTtl } from "./ttl.ts";
import { DEFAULT_CONCURRENCY } from "./upload.ts";
import type { CommandContext } from "./commands/context.ts";
import { deleteArtifact } from "./commands/delete.ts";
import { previewPublish, publish } from "./commands/publish.ts";
import { share } from "./commands/share.ts";

export const HELP = `instahost ${VERSION}: instant hosting and sharing for AI agents.

Usage:
  instahost share <file>    [--ttl 24h] [--access unlisted|public|private] [--name <filename>] [--content-type <type>]
  instahost publish <dir>   [--ttl 24h] [--access unlisted|public] [--include-dotfiles] [--concurrency 6] [--dry-run]
  instahost delete <id|url> [--token <ihd_...>]   (or the owner's API key)

Options for every command:
  --json               print exactly one JSON document on stdout (success or failure)
  --api-key <key>      API key for longer lifetimes, --ttl never and higher limits (or INSTAHOST_API_KEY)
  --verbose            diagnostics on stderr (tokens and signatures are masked)
  --help, --version

--ttl takes a number with s, m, h or d (30m, 24h, 7d), plain seconds, or "never" (needs an API key).
Anonymous artifacts live 24 hours by default and at most 7 days.
publish skips dotfiles (except .well-known), credentials (.env*, keys, .git, ...) and OS metadata,
and lists them under "skipped". Sites must use relative URLs (Vite: base: "./").
publish --dry-run lists what would be published or skipped without contacting InstaHost.
delete uses --token, else --api-key, else INSTAHOST_DELETE_TOKEN, else INSTAHOST_API_KEY; the
environment keeps the token out of the process list.
On a failure, error.fix in the JSON output says what to do next.

Exit codes: 0 ok, 1 internal error, 2 usage, 3 local input (missing file, no index.html, invalid or
sensitive name), 4 authentication or authorization (401, 403), 5 rejected by the server (400, 413,
415, 422 and other 4xx), 6 rate limited or over quota (429), 7 network or server failure, 8
publication failed (upload mismatch, incomplete upload, upload window closed), 9 not found (404).

Run it with npx (Node.js 20 or later), or install it once with npm i -g @instahost/cli:
  npx -y @instahost/cli share ./screenshot.png --json
The npm package named "instahost" (without the @instahost/ scope) is unrelated to this project;
do not install it.
`;

/** Every option the CLI accepts; the docs tests check that each documented flag is one of these. */
export const OPTIONS = {
  json: { type: "boolean" },
  "api-url": { type: "string" },
  "api-key": { type: "string" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
  ttl: { type: "string" },
  access: { type: "string" },
  name: { type: "string" },
  "content-type": { type: "string" },
  "include-dotfiles": { type: "boolean" },
  concurrency: { type: "string" },
  "dry-run": { type: "boolean" },
  token: { type: "string" },
} as const;

/**
 * Options the CLI accepts but never documents (help, READMEs, skill, website). InstaHost cannot be
 * self-hosted: --api-url and INSTAHOST_API_URL exist only for the InstaHost team, to point the CLI
 * at a local or test deployment. The docs tests check that no public text mentions them.
 */
export const UNDOCUMENTED_OPTIONS: readonly string[] = ["api-url"];

/** Options every command accepts. */
export const GLOBAL = ["json", "api-url", "api-key", "verbose", "help", "version"];
/** Options per command, on top of GLOBAL. */
export const PER_COMMAND: Record<string, string[]> = {
  share: ["ttl", "access", "name", "content-type"],
  publish: ["ttl", "access", "include-dotfiles", "concurrency", "dry-run"],
  delete: ["token"],
};

type Values = { [K in keyof typeof OPTIONS]?: (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : string };

export interface MainDeps {
  env?: NodeJS.ProcessEnv;
  streams?: Streams;
  /** Injected in tests. */
  fetch?: typeof fetch;
  sleep?: (seconds: number) => Promise<void>;
}

function defaultStreams(): Streams {
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    stderrIsTty: Boolean(process.stderr.isTTY),
  };
}

function parse(argv: string[]): { command: string | undefined; positionals: string[]; values: Values } {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw usageError(`${err instanceof Error ? err.message : String(err)} (see instahost --help).`);
  }
  const [command, ...positionals] = parsed.positionals;
  return { command, positionals, values: parsed.values as Values };
}

function choice<T extends string>(flag: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw usageError(`--${flag} must be one of ${allowed.join(", ")}.`);
}

async function run(argv: string[], deps: Required<Pick<MainDeps, "env">> & MainDeps, streams: Streams, json: boolean): Promise<ResultDocument | "help" | "version"> {
  const { command, positionals, values } = parse(argv);
  if (values.version) return "version";
  if (values.help || command === undefined || command === "help") return "help";
  const allowed = Object.hasOwn(PER_COMMAND, command) ? PER_COMMAND[command] : undefined;
  if (!allowed) throw usageError(`Unknown command ${JSON.stringify(command)}; use share, publish or delete.`);
  for (const key of Object.keys(values)) {
    if (!GLOBAL.includes(key) && !allowed.includes(key)) throw usageError(`--${key} does not apply to ${command}.`);
  }
  if (positionals.length !== 1) throw usageError(`${command} takes exactly one ${command === "share" ? "file" : command === "publish" ? "directory" : "artifact id"}.`);
  const target = positionals[0] as string;

  const apiUrl = resolveApiUrl(values["api-url"], deps.env);
  const apiKey = resolveApiKey(values["api-key"], deps.env);
  const client = new ApiClient({ apiUrl, log: values.verbose ? (line) => streams.stderr(`${line}\n`) : undefined, sleep: deps.sleep, fetch: deps.fetch });
  const showProgress = !json && !values.verbose && streams.stderrIsTty;
  const ctx: CommandContext = {
    client,
    apiKey,
    fetch: deps.fetch,
    onProgress: showProgress
      ? (done, total) => {
          streams.stderr(`\ruploading ${done}/${total}${done === total ? "\n" : ""}`);
          progress.open = done !== total;
        }
      : undefined,
  };
  const lifetime: Lifetime | null = values.ttl === undefined ? null : parseTtl(values.ttl);

  if (command === "share") {
    return share(ctx, {
      file: target,
      lifetime,
      access: choice("access", values.access, ["unlisted", "public", "private"] as const, "unlisted"),
      name: values.name,
      contentType: values["content-type"],
    });
  }
  if (command === "publish") {
    if (values.access === "private") throw usageError("Private sites are not supported; publish with --access unlisted or public, or share single files privately.");
    const concurrency = values.concurrency === undefined ? DEFAULT_CONCURRENCY : Number(values.concurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw usageError("--concurrency must be an integer from 1 to 16.");
    const options = {
      dir: target,
      lifetime,
      access: choice("access", values.access, ["unlisted", "public"] as const, "unlisted"),
      includeDotfiles: values["include-dotfiles"] ?? false,
      concurrency,
    };
    // A dry run has passed the same option and API key checks as a publish; it stops before any request.
    return values["dry-run"] ? previewPublish(options) : publish(ctx, options);
  }
  if (command === "delete") {
    // Flags before the environment: --token, then --api-key, then
    // INSTAHOST_DELETE_TOKEN, then INSTAHOST_API_KEY.
    const credential = resolveDeleteToken(values.token, {}) ?? (values["api-key"] !== undefined ? apiKey : null) ?? resolveDeleteToken(undefined, deps.env) ?? apiKey;
    return deleteArtifact(ctx, { ref: target, credential });
  }
  throw usageError(`Unknown command ${JSON.stringify(command)}; use share, publish or delete.`);
}

/** Whether a "\ruploading n/N" progress line is still open on stderr (it must end before any error). */
const progress = { open: false };

/**
 * Last resort for a real process: an error that escapes main() still ends as one JSON document
 * (or a human-readable error) and exit code 1.
 */
function installCrashHandlers(argv: string[], streams: Streams): void {
  const crash = (err: unknown) => {
    const error = CliError.local("internal_error", `Unexpected error: ${err instanceof Error ? err.name : "unknown"}`, EXIT.internal);
    if (argv.includes("--json")) printJson(streams, errorDocument(error));
    else printHumanError(streams, error);
    process.exit(EXIT.internal);
  };
  process.once("uncaughtException", crash);
  process.once("unhandledRejection", crash);
}

/** Runs the CLI; returns the exit code. Never throws. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const streams = deps.streams ?? defaultStreams();
  if (!deps.streams) installCrashHandlers(argv, streams);
  const json = argv.includes("--json");
  const env = deps.env ?? process.env;
  const fail = (err: unknown): number => {
    if (progress.open) {
      streams.stderr("\n");
      progress.open = false;
    }
    const cliError =
      err instanceof CliError ? err : CliError.local("internal_error", `Unexpected error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`, EXIT.internal);
    if (json) printJson(streams, errorDocument(cliError));
    else printHumanError(streams, cliError);
    if (argv.includes("--verbose") && !(err instanceof CliError) && err instanceof Error && err.stack) streams.stderr(`${redact(err.stack)}\n`);
    return cliError.exitCode;
  };
  try {
    const result = await run(argv, { ...deps, env }, streams, json);
    if (result === "help") {
      if (json) printJson(streams, { ok: true, help: HELP });
      else streams.stdout(HELP);
      return EXIT.ok;
    }
    if (result === "version") {
      if (json) printJson(streams, { ok: true, version: VERSION });
      else streams.stdout(`${VERSION}\n`);
      return EXIT.ok;
    }
    if (json) printJson(streams, result);
    else printHuman(streams, result);
    return EXIT.ok;
  } catch (err) {
    return fail(err);
  }
}
