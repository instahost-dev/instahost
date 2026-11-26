// instahost delete <id|url>. The credential is the artifact's delete
// token (--token or INSTAHOST_DELETE_TOKEN) or the owner's API key. DELETE is idempotent on the
// server, so it is retried like the other idempotent calls.
import { CliError, EXIT, usageError } from "../errors.ts";
import type { DeletedDocument } from "../output.ts";
import type { CommandContext } from "./context.ts";

const ARTIFACT_ID = /^[a-z2-7]{26}$/;

/**
 * The artifact id from an id or from one of its URLs. A subdomain-mode site URL carries the id as
 * its first host label, and that wins: the site's own paths may contain id-shaped segments
 * (https://<A>.<content>/<B>/ is a page of site A, not artifact B). Otherwise the id is the first
 * path segment (files URLs, path-mode site URLs).
 */
export function parseArtifactRef(ref: string): string {
  const trimmed = ref.trim();
  if (ARTIFACT_ID.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const label = url.hostname.split(".")[0] ?? "";
    if (ARTIFACT_ID.test(label)) return label;
    const segment = url.pathname.split("/")[1] ?? "";
    if (ARTIFACT_ID.test(segment)) return segment;
  } catch {}
  throw usageError(`${JSON.stringify(ref)} is not an artifact id (26 characters a-z and 2-7) or an artifact URL.`);
}

export async function deleteArtifact(ctx: CommandContext, options: { ref: string; credential: string | null }): Promise<DeletedDocument> {
  const id = parseArtifactRef(options.ref);
  const credential = options.credential;
  if (!credential) throw usageError("delete needs the artifact's delete token (--token or INSTAHOST_DELETE_TOKEN) or the owner's API key.");
  const r = await ctx.client.call<{ artifact: { id: string; status: string; deleted_at?: string } }>("DELETE", `/v1/artifacts/${id}`, {
    token: credential,
    phase: "delete",
  });
  if (typeof r?.artifact?.id !== "string" || typeof r.artifact.status !== "string") throw CliError.local("bad_response", "The API's answer to delete has no artifact.", EXIT.network);
  return { ok: true, id: r.artifact.id, status: r.artifact.status, deleted_at: r.artifact.deleted_at ?? null };
}
