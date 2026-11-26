import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/main.ts";

/**
 * The package directory (packages/cli), found by walking up from this file, so the same test runs
 * from test/ under type stripping and from build/test/ once compiled.
 */
export const PACKAGE_ROOT: string = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === "@instahost/cli") return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("package.json of @instahost/cli not found above the tests");
    dir = parent;
  }
})();

/** The repository root (two levels above the package). */
export const REPO_ROOT: string = join(PACKAGE_ROOT, "..", "..");

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
  /** The single JSON document on stdout (throws unless there is exactly one line of JSON). */
  json: Record<string, any>;
  sleeps: number[];
}

/** Runs main() in-process with captured streams and a sleep that only records. */
export async function run(argv: string[], options: { env?: NodeJS.ProcessEnv; tty?: boolean; fetch?: typeof fetch } = {}): Promise<Run> {
  let stdout = "";
  let stderr = "";
  const sleeps: number[] = [];
  const code = await main(argv, {
    env: options.env ?? {},
    streams: { stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t), stderrIsTty: options.tty ?? false },
    sleep: async (s) => void sleeps.push(s),
    fetch: options.fetch,
  });
  return {
    code,
    stdout,
    stderr,
    sleeps,
    get json() {
      const lines = stdout.split("\n").filter(Boolean);
      if (lines.length !== 1) throw new Error(`expected exactly one stdout line, got ${lines.length}: ${stdout}`);
      return JSON.parse(lines[0] as string);
    },
  };
}

/**
 * A temporary directory for a whole test file, removed when the file's process exits. Test files
 * set up with top-level await instead of root-level before/after hooks, which Node 20.0 never runs.
 */
export async function fileTempDir(): Promise<string> {
  const { dir } = await tempDir();
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "instahost-cli-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Writes files (relative path -> content) under dir, creating parents. */
export async function writeTree(dir: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

export const md5 = (data: string | Buffer) => createHash("md5").update(data).digest("hex");
