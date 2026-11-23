// Directory walk and file hashing. The path rules are src/vendor/paths.ts, a verbatim copy of the
// rules the API enforces.
//
// - Regular files only. Symlinks are never followed and are reported as skipped ("symlink"); other
//   special files (sockets, FIFOs, devices) are reported as "special".
// - Exclusions (walkExclusion): sensitive paths and OS metadata always, dot-prefixed segments
//   unless --include-dotfiles (".well-known" is kept). A directory whose every descendant would be
//   excluded (".git", "__MACOSX", a dot directory) is reported once with a trailing "/" and not
//   descended into, so a large .git or node cache costs nothing.
// - Manifest paths use "/" and NFC; files are still opened by their on-disk names. A remaining path
//   that fails validatePath, or two names that collide after NFC, stop the publish (exit 3).
// - Each file is opened without following symlinks, then stat-ed and MD5-hashed by streaming.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { inputError } from "./errors.ts";
import { type PathProblem, findDuplicatePaths, validatePath, walkExclusion } from "./vendor/paths.ts";

/** A walk that finds more files than this stops before hashing (the server's ceiling is 10,000). */
export const MAX_WALK_FILES = 10_000;
/** HTML and CSS files larger than this are not scanned for root-absolute references. */
export const SCAN_MAX_BYTES = 2 * 1024 * 1024;

export type SkipReason = "sensitive" | "os_metadata" | "dotfile" | "symlink" | "special";

export interface Skipped {
  path: string;
  reason: SkipReason;
}

export interface LocalFile {
  /** Manifest path: "/"-separated, NFC. */
  path: string;
  /** On-disk path to read. */
  absPath: string;
  size: number;
  md5: string;
  /** Identity of the hashed file, checked again before upload. */
  dev: number;
  ino: number;
}

export interface WalkResult {
  files: LocalFile[];
  skipped: Skipped[];
  totalBytes: number;
}

interface Candidate {
  path: string;
  raw: string;
  absPath: string;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Size and MD5 of a regular file, read once by streaming; refuses symlinks and special files. */
export async function hashFile(absPath: string, displayPath: string): Promise<{ size: number; md5: string; dev: number; ino: number }> {
  let handle;
  try {
    handle = await open(absPath, constants.O_RDONLY | NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw inputError("symlink_refused", `${displayPath} is a symbolic link; symlinks are never followed.`, { path: displayPath });
    if (code === "ENOENT") throw inputError("file_not_found", `${displayPath} does not exist.`, { path: displayPath });
    throw inputError("unreadable_file", `${displayPath} cannot be read (${code ?? "error"}).`, { path: displayPath });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw inputError("not_a_file", `${displayPath} is not a regular file.`, { path: displayPath });
    const hash = createHash("md5");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += (chunk as Buffer).byteLength;
      hash.update(chunk as Buffer);
    }
    if (size !== stat.size) throw inputError("file_changed", `${displayPath} changed while it was being read; try again.`, { path: displayPath });
    return { size, md5: hash.digest("hex"), dev: stat.dev, ino: stat.ino };
  } finally {
    await handle.close();
  }
}

async function collect(root: string, includeDotfiles: boolean): Promise<{ candidates: Candidate[]; skipped: Skipped[] }> {
  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];
  const pending: { abs: string; raw: string }[] = [{ abs: root, raw: "" }];
  while (pending.length) {
    const dir = pending.pop() as { abs: string; raw: string };
    let entries;
    try {
      entries = await readdir(dir.abs, { withFileTypes: true });
    } catch (err) {
      throw inputError("unreadable_directory", `${dir.raw || "."} cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"}).`, { path: dir.raw || "." });
    }
    for (const entry of entries) {
      const raw = dir.raw ? `${dir.raw}/${entry.name}` : entry.name;
      const path = raw.normalize("NFC");
      const abs = join(dir.abs, entry.name);
      if (entry.isDirectory()) {
        // Probe with a harmless child name: non-null means the directory itself excludes everything.
        const excluded = walkExclusion(`${path}/x`, includeDotfiles);
        if (excluded) skipped.push({ path: `${path}/`, reason: excluded });
        else pending.push({ abs, raw });
        continue;
      }
      const excluded = walkExclusion(path, includeDotfiles);
      if (excluded) skipped.push({ path, reason: excluded });
      else if (entry.isSymbolicLink()) skipped.push({ path, reason: "symlink" });
      else if (!entry.isFile()) skipped.push({ path, reason: "special" });
      else candidates.push({ path, raw, absPath: abs });
      if (candidates.length > MAX_WALK_FILES) {
        throw inputError("walk_too_many_files", `The directory holds more than ${MAX_WALK_FILES} files to publish.`, { limit: MAX_WALK_FILES });
      }
    }
  }
  return { candidates, skipped };
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Walks a site directory: the files to publish (sorted, hashed) and what was skipped. */
export async function walkSite(root: string, options: { includeDotfiles: boolean }): Promise<WalkResult> {
  const { candidates, skipped } = await collect(root, options.includeDotfiles);
  const invalid: { path: string; reason: PathProblem }[] = [];
  for (const c of candidates) {
    const check = validatePath(c.path);
    if (!check.ok) invalid.push({ path: c.path, reason: check.reason });
  }
  if (invalid.length) {
    throw inputError("invalid_path", `${invalid.length} file name(s) cannot be published as they are; rename them.`, { paths: invalid.sort(byPath).slice(0, 20), count: invalid.length });
  }
  const duplicates = findDuplicatePaths(candidates.map((c) => c.raw));
  if (duplicates.length) {
    throw inputError("duplicate_path", "Two file names become the same path after Unicode normalisation (NFC).", {
      paths: duplicates.slice(0, 20).map((d) => ({ path: d.path.normalize("NFC"), duplicate_of: d.duplicateOf })),
    });
  }
  candidates.sort(byPath);
  skipped.sort(byPath);
  const files: LocalFile[] = [];
  let totalBytes = 0;
  for (const c of candidates) {
    const { size, md5, dev, ino } = await hashFile(c.absPath, c.path);
    files.push({ path: c.path, absPath: c.absPath, size, md5, dev, ino });
    totalBytes += size;
  }
  return { files, skipped, totalBytes };
}

// Root-absolute references break in path mode, where every site lives under /<id>/ on the shared
// sites origin.
const HTML_ATTRIBUTE = /\b(?:src|href|action|formaction|poster|data|srcset)\s*=\s*["']?\s*\/(?![/\\])/i;
const CSS_URL = /url\(\s*["']?\s*\/(?![/\\])|@import\s+["']\/(?![/\\])/i;
const BASE_ROOT = /<base\s[^>]*href\s*=\s*["']?\s*\/(?![/\\])/i;

export interface RootAbsoluteReference {
  path: string;
  base: boolean;
}

/** HTML and CSS files that reference root-absolute URLs ("/app.js") or set <base href="/">. */
export async function findRootAbsoluteReferences(files: Pick<LocalFile, "path" | "absPath" | "size">[]): Promise<RootAbsoluteReference[]> {
  const found: RootAbsoluteReference[] = [];
  for (const f of files) {
    const lower = f.path.toLowerCase();
    const isHtml = lower.endsWith(".html") || lower.endsWith(".htm");
    const isCss = lower.endsWith(".css");
    if ((!isHtml && !isCss) || f.size > SCAN_MAX_BYTES) continue;
    let handle;
    try {
      handle = await open(f.absPath, constants.O_RDONLY | NOFOLLOW);
      const text = (await handle.readFile()).toString("utf8");
      const base = isHtml && BASE_ROOT.test(text);
      if (base || CSS_URL.test(text) || (isHtml && HTML_ATTRIBUTE.test(text))) found.push({ path: f.path, base });
    } catch {
      // A file that vanished is reported by the upload; the scan is advisory.
    } finally {
      await handle?.close();
    }
  }
  return found;
}
