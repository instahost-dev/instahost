// instahost share <file>.
// Refuses symlinks, and refuses names that look like credentials: the shared name (--name or the
// file's own name), the real file's name, and every directory on its real path (so a file inside
// ~/.ssh or .git is refused even if its own name looks harmless).
import { lstat, realpath } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { CliError, EXIT, inputError } from "../errors.ts";
import type { PublishedDocument } from "../output.ts";
import { type Lifetime, lifetimeFields } from "../ttl.ts";
import { afterCreate, createArtifact, uploadAndComplete } from "../upload.ts";
import { sensitiveRule, validatePath } from "../vendor/paths.ts";
import { hashFile } from "../walk.ts";
import type { CommandContext } from "./context.ts";

export interface ShareOptions {
  file: string;
  lifetime: Lifetime | null;
  access: "unlisted" | "public" | "private";
  name: string | undefined;
  contentType: string | undefined;
}

function refuseSensitive(label: string, path: string): void {
  const rule = sensitiveRule(path);
  if (rule) throw inputError("sensitive_file", `Refusing to share ${label}: it looks like a credential or VCS data (${rule}).`, { paths: [{ path: basename(path), reason: rule }] });
}

export async function share(ctx: CommandContext, options: ShareOptions): Promise<PublishedDocument> {
  const display = options.file;
  let info;
  try {
    info = await lstat(options.file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw inputError("file_not_found", `${display} does not exist.`, { path: display });
    throw inputError("unreadable_file", `${display} cannot be read (${code ?? "error"}).`, { path: display });
  }
  if (info.isSymbolicLink()) throw inputError("symlink_refused", `${display} is a symbolic link; share the file it points to instead.`, { path: display });
  if (info.isDirectory()) throw inputError("not_a_file", `${display} is a directory; use instahost publish for directories.`, { path: display });
  if (!info.isFile()) throw inputError("not_a_file", `${display} is not a regular file.`, { path: display });

  const real = await realpath(options.file);
  const name = (options.name ?? basename(resolve(options.file))).normalize("NFC");
  const check = validatePath(name);
  if (!check.ok || name.includes("/")) {
    throw inputError("invalid_path", `The file name ${JSON.stringify(name)} cannot be used${check.ok ? " (no / allowed)" : ` (${check.reason})`}; pass --name.`, {
      paths: [{ path: name, reason: check.ok ? "slash" : check.reason }],
    });
  }
  refuseSensitive(JSON.stringify(name), name);
  refuseSensitive(display, basename(real));
  refuseSensitive(display, real.split(sep).filter(Boolean).join("/"));

  const { size, md5, dev, ino } = await hashFile(options.file, display);
  const file = { path: name, size, md5, content_type: options.contentType };
  const created = await createArtifact(ctx.client, {
    type: "file", access: options.access, ...lifetimeFields(options.lifetime), files: [file],
  }, ctx.apiKey);
  const artifact = await afterCreate(created, async () => {
    if (created.upload.protocol !== "gateway-v1" && !created.upload.files.length) {
      throw CliError.local("bad_response", "The API returned no upload URL.", EXIT.network);
    }
    return uploadAndComplete({
      client: ctx.client,
      created,
      apiKey: ctx.apiKey,
      files: [{ path: name, absPath: options.file, size, md5, dev, ino }],
      concurrency: 1,
      onProgress: ctx.onProgress,
      fetch: ctx.fetch,
    });
  });
  return {
    ok: true,
    id: artifact.id,
    type: "file",
    access: artifact.access,
    url: artifact.url,
    expires_at: artifact.expires_at,
    delete_token: created.delete_token,
    access_token: created.access_token ?? null,
    access_url: created.access_url ?? null,
    file_count: artifact.file_count,
    total_bytes: artifact.total_bytes,
    skipped: [],
    warnings: [],
  };
}
