// instahost publish <dir>. Like share,
// it refuses a directory whose real path crosses a sensitive directory (publishing ~/.ssh or a .git
// folder whole); the walk then applies the exclusions to the paths inside it.
import { realpath, stat } from "node:fs/promises";
import { sep } from "node:path";
import { inputError } from "../errors.ts";
import { sensitiveRule } from "../vendor/paths.ts";
import type { PublishedDocument, Warning } from "../output.ts";
import { type Lifetime, lifetimeFields } from "../ttl.ts";
import { type CreateResponse, afterCreate, checkCreated, uploadAndComplete } from "../upload.ts";
import { findRootAbsoluteReferences, walkSite } from "../walk.ts";
import type { CommandContext } from "./context.ts";

export interface PublishOptions {
  dir: string;
  lifetime: Lifetime | null;
  access: "unlisted" | "public";
  includeDotfiles: boolean;
  concurrency: number;
}

const MAX_WARNING_PATHS = 20;

export async function publish(ctx: CommandContext, options: PublishOptions): Promise<PublishedDocument> {
  const display = options.dir;
  try {
    if (!(await stat(options.dir)).isDirectory()) throw inputError("not_a_directory", `${display} is not a directory; use instahost share for a single file.`, { path: display });
  } catch (err) {
    if ((err as { name?: string }).name === "CliError") throw err;
    throw inputError("file_not_found", `${display} does not exist.`, { path: display });
  }
  const rule = sensitiveRule(`${(await realpath(options.dir)).split(sep).filter(Boolean).join("/")}/index.html`);
  if (rule) throw inputError("sensitive_file", `Refusing to publish ${display}: it is inside a credential or VCS directory (${rule}).`, { paths: [{ path: display, reason: rule }] });
  const walked = await walkSite(options.dir, { includeDotfiles: options.includeDotfiles });
  if (walked.files.length === 0) {
    throw inputError("empty_directory", `${display} has no files to publish.`, { path: display, skipped: walked.skipped.length });
  }
  if (!walked.files.some((f) => f.path === "index.html")) {
    throw inputError("missing_index", `${display} has no index.html at its root; a site needs one.`, { path: display });
  }
  const rootAbsolute = await findRootAbsoluteReferences(walked.files);

  const created = await ctx.client.call<CreateResponse>("POST", "/v1/artifacts", {
    body: { type: "site", access: options.access, ...lifetimeFields(options.lifetime), files: walked.files.map((f) => ({ path: f.path, size: f.size, md5: f.md5 })) },
    token: ctx.apiKey,
    idempotent: false,
    phase: "create",
  });
  checkCreated(created);
  const artifact = await afterCreate(created, () =>
    uploadAndComplete({
      client: ctx.client,
      created,
      apiKey: ctx.apiKey,
      files: walked.files,
      concurrency: options.concurrency,
      onProgress: ctx.onProgress,
      fetch: ctx.fetch,
    }),
  );

  // Root-absolute references only break when the site lives under a path (path mode).
  const warnings: Warning[] = [];
  if (rootAbsolute.length && new URL(artifact.url).pathname !== "/") {
    const paths = rootAbsolute.map((r) => r.path);
    warnings.push({
      code: "root_absolute_reference",
      message: `${paths.length} file(s) use root-absolute URLs ("/app.js")${rootAbsolute.some((r) => r.base) ? " or <base href=\"/\">" : ""}, which break under ${new URL(artifact.url).pathname}; use relative URLs (for example Vite base: "./")`,
      paths: paths.slice(0, MAX_WARNING_PATHS),
    });
  }
  return {
    ok: true,
    id: artifact.id,
    type: "site",
    access: artifact.access,
    url: artifact.url,
    expires_at: artifact.expires_at,
    delete_token: created.delete_token,
    access_token: null,
    access_url: null,
    file_count: artifact.file_count,
    total_bytes: artifact.total_bytes,
    skipped: walked.skipped,
    warnings,
  };
}
