// Pure units: TTL parsing, the Node gate, API URL rules, redaction, artifact references and the
// exit-code mapping for every API error code.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ERROR_CODES } from "./error-codes.ts";
import { retryAfterSeconds } from "../src/api-client.ts";
import { errorDocument, terminalSafe } from "../src/output.ts";
import { checkUploadUrl } from "../src/upload.ts";
import { parseArtifactRef } from "../src/commands/delete.ts";
import { DEFAULT_API_URL, isLoopbackHost, parseApiUrl, resolveApiKey, resolveApiUrl, resolveDeleteToken } from "../src/config.ts";
import { CliError, EXIT, exitCodeForApiError } from "../src/errors.ts";
import { MIN_NODE, nodeTooOld, tooOldDocument } from "../src/node-check.mjs";
import { redact } from "../src/redact.ts";
import { parseTtl } from "../src/ttl.ts";

const throwsCode = (fn: () => unknown, code: string, exit: number) =>
  assert.throws(fn, (err: unknown) => err instanceof CliError && err.code === code && err.exitCode === exit);

describe("--ttl", () => {
  it("accepts units, plain seconds and never", () => {
    assert.deepEqual(parseTtl("90s"), { kind: "ttl", seconds: 90 });
    assert.deepEqual(parseTtl("30m"), { kind: "ttl", seconds: 1800 });
    assert.deepEqual(parseTtl("24h"), { kind: "ttl", seconds: 86_400 });
    assert.deepEqual(parseTtl("7d"), { kind: "ttl", seconds: 604_800 });
    assert.deepEqual(parseTtl("3600"), { kind: "ttl", seconds: 3600 });
    assert.deepEqual(parseTtl(" 2H "), { kind: "ttl", seconds: 7200 });
    assert.deepEqual(parseTtl("never"), { kind: "persistent" });
    assert.deepEqual(parseTtl("NEVER"), { kind: "persistent" });
  });
  it("refuses anything else as a usage error (exit 2)", () => {
    for (const bad of ["", "0", "0s", "-5", "1.5h", "1w", "24 h", "h", "1e3", "1hh", "forever", "9999999999999d"]) throwsCode(() => parseTtl(bad), "usage", 2);
  });
});

describe("Node version gate (runs before the compiled CLI is imported)", () => {
  it("requires Node.js 20 or later", () => {
    assert.deepEqual(MIN_NODE, [20, 0]);
    for (const v of ["20.0.0", "20.19.0", "21.0.0", "22.12.0", "22.18.0", "23.0.0", "23.5.9", "24.21.0", "25.4.0", "30.0.0"]) assert.equal(nodeTooOld(v), false, v);
    for (const v of ["19.9.0", "18.20.4", "16.0.0", "0.12.0", "garbage", "", "20", "v20.0.0"]) assert.equal(nodeTooOld(v), true, v);
  });
  it("describes the failure as one JSON document with exit code 2", () => {
    const doc = tooOldDocument("18.20.4");
    assert.equal(doc.ok, false);
    assert.equal(doc.error.exit_code, 2);
    assert.equal(doc.error.code, "node_too_old");
    assert.deepEqual(doc.error.details, { required: ">=20.0.0", found: "18.20.4" });
    assert.match(doc.error.message, /Node\.js >= 20 is required \(this is 18\.20\.4\)/);
  });
});

describe("API URL and credentials", () => {
  it("accepts https and loopback http, as an origin", () => {
    assert.equal(parseApiUrl("https://instahost.example.workers.dev"), "https://instahost.example.workers.dev");
    assert.equal(parseApiUrl("https://instahost.example.workers.dev/"), "https://instahost.example.workers.dev");
    assert.equal(parseApiUrl("http://localhost:8787"), "http://localhost:8787");
    assert.equal(parseApiUrl("http://127.0.0.1:9"), "http://127.0.0.1:9");
    assert.equal(parseApiUrl("http://[::1]:8787"), "http://[::1]:8787");
  });
  it("refuses plain http elsewhere, paths, queries and embedded credentials", () => {
    // *.localhost names go through the system resolver, which may ask DNS first: not trusted for http.
    for (const bad of ["http://example.com", "http://10.0.0.1", "ftp://x", "https://x/v1", "https://x/?a=1", "https://u:p@x", "https://x/#f", "not a url", "http://localhost.evil.com", "http://api.localhost"]) {
      throwsCode(() => parseApiUrl(bad), "usage", 2);
    }
    assert.equal(isLoopbackHost("localhost.evil.com"), false);
    assert.equal(isLoopbackHost("files.localhost"), false);
    assert.equal(isLoopbackHost("127.1.2.3"), true);
  });
  it("accepts plain-http upload URLs only on loopback, and only while the API is plain-http loopback", () => {
    assert.equal(checkUploadUrl("http://localhost:8787/cdn-cgi/local/r2/s3/b/t/x/0", "http://localhost:8787").protocol, "http:");
    assert.equal(checkUploadUrl("https://acct.r2.cloudflarestorage.com/b/t/x/0", "https://api.example").protocol, "https:");
    for (const [upload, api] of [["http://localhost:8787/b/k", "https://api.example"], ["http://files.localhost:8787/b/k", "http://localhost:8787"], ["http://10.0.0.1/b/k", "http://localhost:8787"]]) {
      throwsCode(() => checkUploadUrl(upload as string, api as string), "unsafe_url", 7);
    }
  });
  it("takes the flag over the environment over the built-in default, and asks for a URL when there is none", () => {
    assert.equal(resolveApiUrl("https://a.example", { INSTAHOST_API_URL: "https://b.example" }, "https://c.example"), "https://a.example");
    assert.equal(resolveApiUrl(undefined, { INSTAHOST_API_URL: "https://b.example" }, "https://c.example"), "https://b.example");
    assert.equal(resolveApiUrl(undefined, {}, "https://c.example"), "https://c.example");
    throwsCode(() => resolveApiUrl(undefined, {}, ""), "usage", 2);
    // The production API origin; the service's deploy preflight checks it against its API_ORIGIN.
    assert.equal(DEFAULT_API_URL, "https://instahost.dev");
    assert.equal(resolveApiUrl(undefined, {}), DEFAULT_API_URL);
  });
  it("checks key and token formats before sending them anywhere", () => {
    const key = `ihk_abcdefghijkl_${"A".repeat(43)}`;
    assert.equal(resolveApiKey(undefined, { INSTAHOST_API_KEY: key }), key);
    assert.equal(resolveApiKey(undefined, {}), null);
    throwsCode(() => resolveApiKey("ihk_short", {}), "usage", 2);
    throwsCode(() => resolveApiKey(`ihd_${"A".repeat(43)}`, {}), "usage", 2);
    const tok = `ihd_${"B".repeat(43)}`;
    assert.equal(resolveDeleteToken(undefined, { INSTAHOST_DELETE_TOKEN: tok }), tok);
    throwsCode(() => resolveDeleteToken(`iha_${"B".repeat(43)}`, {}), "usage", 2);
  });
});

describe("redaction of diagnostics", () => {
  it("masks tokens, keys, signatures, credentials, ?token= and bearer values", () => {
    const text = `ihd_${"a".repeat(43)} iha_${"b".repeat(43)} ihk_abcdefghijkl_${"c".repeat(43)} https://r2/x?X-Amz-Credential=AK%2F1&X-Amz-Signature=abc123 /f?token=secret Bearer zzz`;
    const out = redact(text);
    assert.doesNotMatch(out, /a{43}|b{43}|c{43}|abc123|AK%2F1|secret|zzz/);
    assert.match(out, /ihd_\*\*\* iha_\*\*\* ihk_\*\*\*/);
  });
});

describe("artifact references for delete", () => {
  const id = "abcdefghijklmnopqrstuvwxyz";
  it("accepts an id or any of its URLs", () => {
    assert.equal(parseArtifactRef(id), id);
    assert.equal(parseArtifactRef(`http://files.localhost:8787/${id}/a.png`), id);
    assert.equal(parseArtifactRef(`https://instahost-sites.x.workers.dev/${id}/`), id);
    assert.equal(parseArtifactRef(`https://${id}.sites.example.com/`), id);
    // A page of site A whose path looks like another id is still site A (subdomain mode).
    const other = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
    assert.equal(parseArtifactRef(`https://${id}.instahost.cloud/${other}/index.html`), id);
    assert.equal(parseArtifactRef(`https://files.instahost.cloud/${other}/a.png`), other);
  });
  it("refuses anything else", () => {
    for (const bad of ["abc", id.toUpperCase(), `${id}1`, "https://x.example/abc/"]) throwsCode(() => parseArtifactRef(bad), "usage", 2);
  });
});

describe("exit codes for API errors", () => {
  it("maps every error code the server can send to a documented exit code, in every phase", () => {
    const documented = new Set<number>(Object.values(EXIT));
    for (const [code, status] of Object.entries(ERROR_CODES)) {
      for (const phase of ["create", "publish", "delete"] as const) {
        const exit = exitCodeForApiError(status, code, phase);
        assert.ok(documented.has(exit) && exit !== 0 && exit !== 1 && exit !== 2 && exit !== 3, `${code} (${status}) in ${phase} -> ${exit}`);
      }
    }
  });
  it("follows the documented table", () => {
    assert.equal(exitCodeForApiError(401, "invalid_api_key", "create"), 4);
    assert.equal(exitCodeForApiError(403, "forbidden", "publish"), 4); // owner_key_revoked
    assert.equal(exitCodeForApiError(403, "persistent_requires_api_key", "create"), 4);
    assert.equal(exitCodeForApiError(400, "sensitive_file", "create"), 5);
    assert.equal(exitCodeForApiError(413, "too_many_files", "create"), 5);
    assert.equal(exitCodeForApiError(415, "unsupported_media_type", "create"), 5);
    assert.equal(exitCodeForApiError(422, "ttl_too_long", "create"), 5);
    assert.equal(exitCodeForApiError(422, "private_sites_unsupported", "create"), 5);
    assert.equal(exitCodeForApiError(429, "quota_exceeded", "create"), 6);
    assert.equal(exitCodeForApiError(429, "rate_limited", "delete"), 6);
    assert.equal(exitCodeForApiError(500, "internal_error", "create"), 7);
    assert.equal(exitCodeForApiError(503, "service_misconfigured", "publish"), 7);
    assert.equal(exitCodeForApiError(422, "upload_mismatch", "publish"), 8);
    assert.equal(exitCodeForApiError(409, "upload_incomplete", "publish"), 8);
    assert.equal(exitCodeForApiError(409, "artifact_failed", "publish"), 8);
    assert.equal(exitCodeForApiError(409, "upload_url_limit", "publish"), 8);
    assert.equal(exitCodeForApiError(409, "complete_attempt_limit", "publish"), 8);
    assert.equal(exitCodeForApiError(410, "gone", "publish"), 8);
    assert.equal(exitCodeForApiError(404, "not_found", "delete"), 9);
    assert.equal(exitCodeForApiError(405, "method_not_allowed", "create"), 5);
  });
});

describe("Retry-After", () => {
  it("reads delta-seconds and IMF-fixdates, and nothing else", () => {
    assert.equal(retryAfterSeconds("60"), 60);
    assert.equal(retryAfterSeconds(" 7 "), 7);
    assert.equal(retryAfterSeconds(null), null);
    const now = Date.parse("Sun, 22 Nov 2026 10:00:00 GMT");
    assert.equal(retryAfterSeconds("Sun, 22 Nov 2026 10:00:05 GMT", now), 5);
    for (const bad of ["soon", "-5", "1.5", "120, 5", "2026-11-22T10:00:05Z", "Sunday, 22-Nov-26 10:00:05 GMT"]) assert.equal(retryAfterSeconds(bad, now), null, bad);
  });
});

describe("error documents", () => {
  it("redact each string value, so quotes and backslashes cannot corrupt the JSON", () => {
    const err = new CliError("file_not_found", 'x&token=a".png does not exist', 3, { path: '/tmp/x&token=a".png', nested: [{ v: 'Bearer a"b\\c' }] });
    const doc = errorDocument(err);
    assert.equal(doc.error.code, "file_not_found");
    assert.equal(doc.error.details?.path, '/tmp/x&token=***".png');
    assert.equal(JSON.parse(JSON.stringify(doc)).error.exit_code, 3);
  });
  it("carry an artifact created before the failure, unredacted, so it can still be deleted", () => {
    const err = new CliError("upload_failed", "x", 7, { path: "a" });
    err.artifact = { id: "a".repeat(26), url: "https://f/x", delete_token: `ihd_${"T".repeat(43)}`, access_url: null };
    assert.equal((errorDocument(err).error.details?.artifact as { delete_token: string }).delete_token, `ihd_${"T".repeat(43)}`);
  });
  it("show control characters as escapes in human output", () => {
    assert.equal(terminalSafe("a\u001b]52;c;eA==\u0007b\u202ec\nd"), "a\\u001b]52;c;eA==\\u0007b\\u202ec\\u000ad");
  });
});
