// An in-process fake of the InstaHost API and of R2's S3 endpoint, for full share and publish
// flows. Two servers on two ports, so tests can prove that credentials never reach the storage origin. Faults are injected
// per request through hooks.
import { createHash, randomBytes } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  server: "api" | "s3";
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface FakeFile {
  path: string;
  size: number;
  md5: string;
  content_type?: string;
  issued: number;
}

export interface FakeArtifact {
  id: string;
  type: "file" | "site";
  access: string;
  deleteToken: string;
  ownerKey: string | null;
  status: "pending" | "published" | "failed" | "deleted";
  files: FakeFile[];
  completeCalls: number;
  expiresAt: string | null;
  gateway: { credential: string; until: number } | null;
}

/**
 * Return a response to override the fake's normal answer, "drop" to cut the connection before any
 * answer, "cut" to send 200 headers and half a body and then cut it, or null to answer normally.
 */
type HookResult = { status: number; body?: unknown; headers?: Record<string, string> } | "drop" | "cut" | null;
export type Hook<Extra = never> = (req: RecordedRequest, ctx: { artifact?: FakeArtifact; attempt: number; path?: string }) => HookResult | Extra;

export interface FakeOptions {
  batchSize?: number;
  urlTtlSeconds?: number;
  initialUrlTtlSeconds?: number;
  maxIssues?: number;
  /** Origin the API advertises for complete/uploads URLs (defaults to its own). */
  advertisedOrigin?: string;
  /** Upload URL base (defaults to the fake S3 server). */
  uploadBase?: string;
  apiKeys?: string[];
  gateway?: {
    force?: boolean;
    ttlSeconds?: number;
    dataOrigin?: string;
    statusOrigin?: string;
    limits?: { anonymous: boolean; api_key: boolean; single_request_max_bytes: number };
    admission?: "off" | "keys" | "all";
    accountKeys?: string[];
  };
  /** A create hook can return "drop-after-create" to store the artifact and lose its response. */
  hooks?: {
    limits?: Hook;
    create?: Hook<"drop-after-create" | "malformed-after-create">;
    uploads?: Hook;
    complete?: Hook;
    delete?: Hook;
    put?: Hook;
    gatewayPut?: Hook<"drop-after-put">;
  };
  /** Milliseconds each PUT takes after it was accepted (a slow upload). */
  putDelayMs?: number;
  /** Include a signed content-length header in every upload instruction, as production R2 does. */
  signContentLength?: boolean;
}

export interface Fake {
  apiUrl: string;
  s3Url: string;
  requests: RecordedRequest[];
  artifacts: Map<string, FakeArtifact>;
  objects: Map<string, Buffer>;
  /** Highest number of PUTs in flight at once. */
  maxConcurrentPuts: number;
  stop(): Promise<void>;
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const newId = () => Array.from(randomBytes(26), (b) => BASE32[b & 31]).join("");
const token = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "application/xml" : "application/json", ...headers });
  res.end(text);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function startFake(options: FakeOptions = {}): Promise<Fake> {
  const batchSize = options.batchSize ?? 50;
  const urlTtl = options.urlTtlSeconds ?? 300;
  const maxIssues = options.maxIssues ?? 3;
  const hooks = options.hooks ?? {};
  const creates = new Map<string, Record<string, unknown>>();
  const attempts = new Map<string, number>();
  const attempt = (key: string) => {
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n);
    return n;
  };
  let inFlight = 0;

  const fake: Fake = {
    apiUrl: "",
    s3Url: "",
    requests: [],
    artifacts: new Map(),
    objects: new Map(),
    maxConcurrentPuts: 0,
    stop: async () => {},
  };

  const keyOf = (a: FakeArtifact, f: FakeFile) => `t/${a.id}/${a.files.indexOf(f)}`;
  const instruction = (a: FakeArtifact, f: FakeFile, ttl: number, expires: number) => {
    const url = `${options.uploadBase ?? fake.s3Url}/bucket/${keyOf(a, f)}?X-Amz-Expires=${ttl}&exp=${expires}&X-Amz-Signature=deadbeef${randomBytes(4).toString("hex")}`;
    return {
      path: f.path,
      method: "PUT",
      url,
      headers: {
        "if-none-match": "*",
        "content-md5": Buffer.from(f.md5, "hex").toString("base64"),
        "x-amz-storage-class": "STANDARD",
        ...(options.signContentLength ? { "content-length": String(f.size) } : {}),
      },
    };
  };
  // Millisecond precision (the real API rounds to seconds; the CLI reads both).
  const batch = (a: FakeArtifact, files: FakeFile[], ttl = urlTtl) => {
    const expires = Date.now() + ttl * 1000;
    return { expires_at: new Date(expires).toISOString(), files: files.map((f) => instruction(a, f, ttl, expires)) };
  };
  const view = (a: FakeArtifact) => ({
    id: a.id,
    type: a.type,
    access: a.access,
    status: a.status,
    url: a.type === "file" ? `http://files.localhost:9/${a.id}/${encodeURIComponent(a.files[0]?.path ?? "")}` : `http://sites.localhost:9/${a.id}/`,
    created_at: "2026-11-21T00:00:00Z",
    expires_at: a.expiresAt,
    published_at: a.status === "published" ? "2026-11-21T00:00:01Z" : null,
    file_count: a.files.length,
    total_bytes: a.files.reduce((n, f) => n + f.size, 0),
    owner: a.ownerKey ? (a.ownerKey.split("_")[1] ?? null) : null,
  });
  const origin = () => options.advertisedOrigin ?? fake.apiUrl;
  const apiError = (code: string, message: string, details?: Record<string, unknown>, fix = "Check the error message, then run the command again.") => ({
    error: { code, message, ...(details ? { details } : {}), fix, docs: `${fake.apiUrl}/docs/api/#error-${code}` },
  });

  const api = createServer(async (req, res) => {
    const body = await readBody(req);
    const rec: RecordedRequest = { server: "api", method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
    fake.requests.push(rec);
    const url = new URL(req.url ?? "/", "http://x");
    const parts = url.pathname.split("/").filter(Boolean); // v1 artifacts <id> <action>
    const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1] ?? null;
    const artifact = parts[2] ? fake.artifacts.get(parts[2]) : undefined;
    const manages = (a: FakeArtifact) => auth !== null && (auth === a.deleteToken || (a.ownerKey !== null && auth === a.ownerKey));
    const respond = (out: HookResult | undefined) => {
      if (out === "drop") {
        req.socket.destroy();
        return true;
      }
      if (out === "cut") {
        res.writeHead(200, { "content-type": "application/json", "content-length": "200" });
        res.write('{"artifact":{"id":');
        setTimeout(() => req.socket.destroy(), 20);
        return true;
      }
      if (out) {
        send(res, out.status, out.body, out.headers);
        return true;
      }
      return false;
    };
    const run = (hook: Hook | undefined, name: string) => respond(hook?.(rec, { artifact, attempt: attempt(`${name}:${parts[2] ?? ""}`) }));

    if (req.method === "GET" && url.pathname === "/v1/limits") {
      if (run(hooks.limits, "limits")) return;
      const limits = options.gateway?.limits;
      return send(res, 200, limits ? { upload_protocols: { "gateway-v1": limits } } : {});
    }
    if (req.method === "POST" && url.pathname === "/v1/artifacts") {
      const hook = hooks.create?.(rec, { attempt: attempt("create:") });
      if (hook !== "drop-after-create" && hook !== "malformed-after-create" && respond(hook)) return;
      if (req.headers["content-type"] !== "application/json") return send(res, 415, apiError("unsupported_media_type", "json please"));
      const accountKey = auth !== null && (options.gateway?.accountKeys ?? []).includes(auth);
      if (auth !== null && !(options.apiKeys ?? []).includes(auth) && !accountKey) {
        return send(res, 401, apiError("invalid_api_key", "The API key is malformed, unknown or revoked."));
      }
      const manifest = body.toString("utf8");
      const key = req.headers["idempotency-key"];
      const replayKey = key ? JSON.stringify([auth, key, manifest]) : null;
      const replay = replayKey ? creates.get(replayKey) : undefined;
      if (replay) return send(res, 201, replay, { "idempotent-replayed": "true" });
      const input = JSON.parse(manifest) as { type: "file" | "site"; access?: string; ttl_seconds?: number; persistent?: boolean; files: FakeFile[]; upload_protocol?: string };
      if (input.persistent && auth === null) {
        return send(res, 403, apiError("persistent_requires_api_key", "Persistent artifacts need an API key.", undefined,
          "Send an API key as `Authorization: Bearer ihk_…`, or drop `persistent` and set `ttl_seconds`."));
      }
      const requestedGateway = input.upload_protocol === "gateway-v1";
      const policy = options.gateway;
      if (requestedGateway) {
        if (!policy?.limits) return send(res, 400, apiError("upload_protocol_unsupported", "The gateway is unknown."));
        const reason = accountKey ? "operator_key_required" : policy.admission === "off" ? "disabled"
          : auth === null && policy.admission === "keys" ? "api_key_required" : null;
        if (reason) return send(res, 409, apiError("upload_protocol_unavailable", "The gateway is unavailable.", { reason }));
        if (input.files.some((file) => file.size > policy.limits!.single_request_max_bytes)) {
          return send(res, 413, apiError("gateway_file_too_large", "File too large for the gateway."));
        }
      }
      const gateway = requestedGateway || policy?.force ? { credential: token("ihu"), until: Date.now() + (policy?.ttlSeconds ?? 900) * 1000 } : null;
      const a: FakeArtifact = {
        id: newId(),
        type: input.type,
        access: input.access ?? "unlisted",
        deleteToken: token("ihd"),
        ownerKey: auth,
        status: "pending",
        files: input.files.map((f) => ({ ...f, issued: 0 })),
        completeCalls: 0,
        expiresAt: input.persistent ? null : "2026-11-22T00:00:00Z",
        gateway,
      };
      fake.artifacts.set(a.id, a);
      const completeUrl = `${origin()}/v1/artifacts/${a.id}/complete`;
      const out: Record<string, unknown> = {
        artifact: view(a),
        delete_token: a.deleteToken,
      };
      if (gateway) {
        out.upload = {
          protocol: "gateway-v1",
          credential: gateway.credential,
          upload_until: new Date(gateway.until).toISOString(),
          data_base_url: `${options.gateway?.dataOrigin ?? fake.apiUrl}/v1/upload-gateway/${a.id}/files`,
          status_url: `${options.gateway?.statusOrigin ?? fake.apiUrl}/v1/upload-gateway/${a.id}/status`,
          complete_url: completeUrl,
        };
      } else {
        const first = a.files.slice(0, batchSize);
        for (const f of first) f.issued++;
        out.upload = { ...batch(a, first, options.initialUrlTtlSeconds), batch_size: batchSize, remaining: a.files.length - first.length, uploads_url: `${origin()}/v1/artifacts/${a.id}/uploads`, complete_url: completeUrl };
      }
      if (a.access === "private") {
        const at = token("iha");
        out.access_token = at;
        out.access_url = `${view(a).url}?token=${at}`;
      }
      if (replayKey) creates.set(replayKey, out);
      if (hook === "drop-after-create") return void req.socket.destroy();
      if (hook === "malformed-after-create") return send(res, 201, { artifact: view(a), delete_token: a.deleteToken });
      return send(res, 201, out);
    }
    if (!artifact) return send(res, 404, apiError("not_found", "No such artifact."));
    if (req.method === "PUT" && parts[1] === "upload-gateway" && parts[3] === "files") {
      const gateway = artifact.gateway;
      if (!gateway || auth !== gateway.credential) return send(res, 403, apiError("forbidden", "An upload credential is required."));
      if (Date.now() >= gateway.until || artifact.status !== "pending") return send(res, 410, apiError("upload_ended", "The upload window has closed."));
      const file = artifact.files[Number(parts[4])];
      if (!file) return send(res, 404, apiError("not_found", "No such manifest index."));
      const key = keyOf(artifact, file);
      inFlight++;
      fake.maxConcurrentPuts = Math.max(fake.maxConcurrentPuts, inFlight);
      try {
        await new Promise((r) => setTimeout(r, options.putDelayMs ?? 5));
        const hook = hooks.gatewayPut?.(rec, { artifact, path: file.path, attempt: attempt(`gatewayPut:${key}`) });
        if (hook !== "drop-after-put" && respond(hook)) return;
        if (req.headers["content-length"] !== String(file.size) || body.length !== file.size) {
          return send(res, 400, apiError("upload_length_mismatch", "The declared length differs from the manifest."));
        }
        if (req.headers["content-encoding"] !== undefined) return send(res, 415, apiError("content_encoding_unsupported", "Send the original bytes."));
        if (createHash("md5").update(body).digest("hex") !== file.md5) return send(res, 422, apiError("checksum_mismatch", "The bytes differ from the manifest."));
        const stored = fake.objects.has(key);
        if (!stored) fake.objects.set(key, body);
        if (hook === "drop-after-put") return void req.socket.destroy();
        return send(res, 200, { state: stored ? "already_stored" : "stored" });
      } finally {
        inFlight--;
      }
    }
    if (!manages(artifact)) return send(res, auth ? 403 : 401, apiError(auth ? "forbidden" : "unauthorized", "This credential cannot manage this artifact."));

    if (req.method === "POST" && parts[3] === "uploads") {
      if (artifact.gateway) return send(res, 409, apiError("upload_protocol_unavailable", "This artifact uses the gateway."));
      if (run(hooks.uploads, "uploads")) return;
      if (artifact.status !== "pending") return send(res, 409, apiError("artifact_not_pending", "not pending"));
      const { paths } = JSON.parse(body.toString("utf8")) as { paths: string[] };
      if (paths.length < 1 || paths.length > batchSize) return send(res, 400, apiError("invalid_request", "1 to batch_size paths", { field: "paths" }));
      const files = paths.map((p) => artifact.files.find((f) => f.path === p));
      if (files.some((f) => !f)) return send(res, 400, apiError("unknown_path", "unknown"));
      const capped = (files as FakeFile[]).filter((f) => f.issued >= maxIssues);
      if (capped.length) return send(res, 409, apiError("upload_url_limit", "cap", { paths: capped.map((f) => f.path), limit: maxIssues }));
      for (const f of files as FakeFile[]) f.issued++;
      return send(res, 200, { upload: batch(artifact, files as FakeFile[]) });
    }
    if (req.method === "POST" && parts[3] === "complete") {
      artifact.completeCalls++;
      if (run(hooks.complete, "complete")) return;
      if (artifact.status === "published") return send(res, 200, { artifact: view(artifact) });
      if (artifact.status === "failed") return send(res, 409, apiError("artifact_failed", "failed"));
      const missing = artifact.files.filter((f) => !fake.objects.has(keyOf(artifact, f))).map((f) => f.path);
      const mismatch = artifact.files.filter((f) => fake.objects.get(keyOf(artifact, f))?.length !== undefined && fake.objects.get(keyOf(artifact, f))?.length !== f.size);
      if (mismatch.length) {
        artifact.status = "failed";
        return send(res, 422, apiError("upload_mismatch", "mismatch", { files: mismatch.map((f) => ({ path: f.path, reason: "size" })), count: mismatch.length }));
      }
      if (missing.length) return send(res, 409, apiError("upload_incomplete", `${missing.length} missing`, { missing: missing.slice(0, 100), missing_count: missing.length }));
      artifact.status = "published";
      return send(res, 200, { artifact: view(artifact) });
    }
    if (req.method === "DELETE" && parts.length === 3) {
      if (run(hooks.delete, "delete")) return;
      artifact.status = "deleted";
      return send(res, 200, { artifact: { id: artifact.id, status: "deleted", deleted_at: "2026-11-21T00:00:02Z" } });
    }
    return send(res, 404, apiError("not_found", "Not found."));
  });

  const s3 = createServer(async (req, res) => {
    inFlight++;
    fake.maxConcurrentPuts = Math.max(fake.maxConcurrentPuts, inFlight);
    try {
      const body = await readBody(req);
      const rec: RecordedRequest = { server: "s3", method: req.method ?? "", path: req.url ?? "", headers: req.headers, body };
      fake.requests.push(rec);
      const url = new URL(req.url ?? "/", "http://x");
      const key = url.pathname.replace(/^\/bucket\//, "");
      const [, id, idx] = key.split("/");
      const artifact = id ? fake.artifacts.get(id) : undefined;
      const file = artifact?.files[Number(idx)];
      await new Promise((r) => setTimeout(r, 5)); // keep requests overlapping so concurrency is observable
      const out = hooks.put?.(rec, { artifact, path: file?.path, attempt: attempt(`put:${key}`) });
      if (out === "drop" || out === "cut") return void req.socket.destroy();
      if (out) return send(res, out.status, out.body ?? "", out.headers);
      if (req.method !== "PUT") return send(res, 405, "<Error><Code>MethodNotAllowed</Code></Error>");
      if (Number(url.searchParams.get("exp")) < Date.now()) return send(res, 403, "<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>");
      if (req.headers["if-none-match"] !== "*") return send(res, 403, "<Error><Code>SignatureDoesNotMatch</Code></Error>");
      if (req.headers["content-md5"] !== createHash("md5").update(body).digest("base64")) return send(res, 400, "<Error><Code>BadDigest</Code></Error>");
      if (fake.objects.has(key)) return send(res, 412, "<Error><Code>PreconditionFailed</Code></Error>");
      if (req.headers["content-length"] !== undefined && Number(req.headers["content-length"]) !== body.length) return send(res, 403, "<Error><Code>SignatureDoesNotMatch</Code></Error>");
      fake.objects.set(key, body);
      if (options.putDelayMs) await new Promise((r) => setTimeout(r, options.putDelayMs));
      return send(res, 200, "");
    } finally {
      inFlight--;
    }
  });

  fake.apiUrl = await listen(api);
  fake.s3Url = await listen(s3);
  fake.stop = async () => {
    api.closeAllConnections();
    s3.closeAllConnections();
    await Promise.all([new Promise((r) => api.close(r)), new Promise((r) => s3.close(r))]);
  };
  return fake;
}
