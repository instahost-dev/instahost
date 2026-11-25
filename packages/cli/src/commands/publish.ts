// instahost publish <dir>. Like share,
// it refuses a directory whose real path crosses a sensitive directory (publishing ~/.ssh or a .git
// folder whole); the walk then applies the exclusions to the paths inside it.
import { realpath, stat } from "node:fs/promises";
import { sep } from "node:path";
import { inputError } from "../errors.ts";
import { sensitiveRule } from "../vendor/paths.ts";
import type { PublishPreviewDocument, PublishedDocument, Warning } from "../output.ts";
import { type Lifetime, lifetimeFields } from "../ttl.ts";
import { type CreateResponse, afterCreate, checkCreated, uploadAndComplete } from "../upload.ts";
import { type RootAbsoluteReference, findRootAbsoluteReferences, walkSite } from "../walk.ts";
import type { CommandContext } from "./context.ts";

interface SiteOptions {
  dir: string;
  includeDotfiles: boolean;
}

export interface PublishOptions extends SiteOptions {
  lifetime: Lifetime | null;
  access: "unlisted" | "public";
  concurrency: number;
}

const MAX_WARNING_PATHS = 20;

async function prepareSite(options: SiteOptions) {
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
  return { ...walked, rootAbsolute: await findRootAbsoluteReferences(walked.files) };
}

function siteWarnings(rootAbsolute: RootAbsoluteReference[], pathname?: string): Warning[] {
  if (!rootAbsolute.length || pathname === "/") return [];
  const impact = pathname ? `break under ${pathname}` : "can break when a site is served under a path";
  return [{
    code: "root_absolute_reference",
    message: `${rootAbsolute.length} file(s) use root-absolute URLs ("/app.js")${rootAbsolute.some((ref) => ref.base) ? " or <base href=\"/\">" : ""}, which ${impact}; use relative URLs (for example Vite base: "./")`,
    paths: rootAbsolute.slice(0, MAX_WARNING_PATHS).map((ref) => ref.path),
  }];
}

export async function previewPublish(options: SiteOptions): Promise<PublishPreviewDocument> {
  const walked = await prepareSite(options);
  return {
    ok: true,
    dry_run: true,
    type: "site",
    files: walked.files.map(({ path, size }) => ({ path, size })),
    file_count: walked.files.length,
    total_bytes: walked.totalBytes,
    skipped: walked.skipped,
    warnings: siteWarnings(walked.rootAbsolute),
  };
}

export async function publish(ctx: CommandContext, options: PublishOptions): Promise<PublishedDocument> {
  const walked = await prepareSite(options);
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
    warnings: walked.rootAbsolute.length ? siteWarnings(walked.rootAbsolute, new URL(artifact.url).pathname) : [],
  };
}
