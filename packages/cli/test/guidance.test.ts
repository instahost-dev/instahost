import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CliError, EXIT, LOCAL_FIX } from "../src/errors.ts";
import { errorDocument } from "../src/output.ts";
import { fileTempDir, run, writeTree } from "./helpers.ts";

const origin = "https://instahost.dev";
const docs = (code: string) => `${origin}/docs/api/#error-${code}`;
const dir = await fileTempDir();
const share = ["share", join(dir, "a.txt")];
const remove = ["delete", "a".repeat(26), "--token", `ihd_${"D".repeat(43)}`];
await writeTree(dir, { "a.txt": "hello" });

const reply = (status: number, error: Record<string, unknown>): typeof fetch =>
  async () => new Response(JSON.stringify({ error }), { status });

describe("failure guidance", () => {
  it("preserves the API's six Bearer examples in JSON and human output", async () => {
    const cases = [
      ["unauthorized", "Send `Authorization: Bearer <token>`: the artifact's delete token or its owner's API key to manage it, an API key or no header at all to create."],
      ["anonymous_disabled", "Send an API key as `Authorization: Bearer ihk_…`, because anonymous uploads are switched off."],
      ["persistent_requires_api_key", "Send an API key as `Authorization: Bearer ihk_…`, or drop `persistent` and set `ttl_seconds`."],
      ["quota_exceeded", "Wait until `details.resets_at`, or send an API key as `Authorization: Bearer ihk_…`, which has its own daily quota."],
      ["service_misconfigured", "Send an API key as `Authorization: Bearer ihk_…`, or retry later, when the rate limiter that anonymous uploads need is available again."],
      ["anonymous_disabled", "Create the artifact again with an API key as `Authorization: Bearer ihk_…`, because anonymous uploads are switched off."],
    ] as const;
    for (const [code, fix] of cases) {
      const message = "The API refused the request.";
      const fetch = reply(403, { code, message, fix, docs: docs(code) });
      const json = await run([...remove, "--json"], { fetch });
      assert.deepEqual(json.json, { ok: false, error: { code, message, fix, docs: docs(code), exit_code: 4 } });
      assert.equal(json.stderr, "");
      const human = await run(remove, { fetch });
      assert.equal(human.stdout, "");
      assert.equal(human.stderr, `instahost: ${message}\n  fix:  ${fix}\n  docs: ${docs(code)}\n`);
    }
  });

  it("masks credential-shaped values, preserves placeholders and escapes terminals", async () => {
    const fix = "Send `Bearer ihk_abcdefghijkl_" + "K".repeat(43) + "`, or use ?token=privatevalue&X-Amz-Signature=abc123 to retry.";
    const fetch = reply(401, { code: "unauthorized", message: "Denied.", fix });
    const json = await run([...remove, "--json"], { fetch });
    assert.equal(json.json.error.fix, "Send `Bearer ihk_***`, or use ?token=***&X-Amz-Signature=*** to retry.");
    const dirty = reply(401, { code: "unauthorized", message: "Denied.", fix: "Use the API key.\u001b[2J" });
    const human = await run(remove, { fetch: dirty });
    assert.match(human.stderr, /fix:  Use the API key\.\\u001b\[2J/);
  });

  it("uses the exit-code guidance for missing and invalid fixes", async () => {
    for (const fix of [undefined, "", 19, "x".repeat(501)]) {
      const result = await run([...share, "--json"], { fetch: reply(403, { code: "sensitive_file", message: "Denied.", fix }) });
      assert.equal(result.json.error.fix, "Check the API key or delete token, then run the command again.");
    }
    const boundary = "x".repeat(500);
    const result = await run([...share, "--json"], { fetch: reply(400, { code: "sensitive_file", message: "Denied.", fix: boundary }) });
    assert.equal(result.json.error.fix, boundary);
  });

  it("omits unsafe docs URLs without dropping the API guidance", async () => {
    const code = "not_found";
    const fix = "Check the artifact id.";
    for (const bad of ["https://example.com/docs", "https://instahost.dev.example.com/docs", "https://instahost.dev:8443/docs", "https://user:password@instahost.dev/docs", "blob:https://instahost.dev/docs", "not a URL", "", true]) {
      const fetch = reply(404, { code, message: "Missing.", fix, docs: bad });
      const json = await run([...remove, "--json"], { fetch });
      assert.equal(json.json.error.fix, fix);
      assert.ok(!Object.hasOwn(json.json.error, "docs"));
      assert.doesNotMatch((await run(remove, { fetch })).stderr, /docs:/);
    }
  });

  it("supplies an imperative sentence for every compiled CLI error code", () => {
    for (const code of Object.keys(LOCAL_FIX) as (keyof typeof LOCAL_FIX)[]) {
      const { error } = errorDocument(CliError.local(code, "Failed.", EXIT.internal));
      assert.match(error.fix, /^(Add|Change|Check|Correct|Leave|Make|Pass|Publish|Rename|Run|Try) .+\.$/);
      assert.doesNotMatch(error.fix, /ih[dak]_\S+|--api-url|Idempotency-Key/);
      assert.ok(!Object.hasOwn(error, "docs"));
    }
  });

  it("replaces the API's create-only recovery instructions in both output modes", async () => {
    for (const [status, code, message] of [
      [500, "internal_error", "The API could not create the artifact."],
      [409, "artifact_not_pending", "This Idempotency-Key's artifact is already published or failed."],
      [410, "gone", "This Idempotency-Key's artifact can no longer be replayed."],
    ] as const) {
      const fetch = reply(status, { code, message, fix: "Send the request with a new Idempotency-Key.", docs: docs(code) });
      const json = await run([...share, "--json", "--verbose"], { fetch });
      const human = await run([...share, "--verbose"], { fetch });
      const expected = code === "internal_error"
        ? "Run the command again later, and report it with the time of the request if the error persists."
        : "Run the command again to create a new artifact.";
      assert.equal(json.json.error.code, code);
      assert.equal(json.json.error.docs, docs(code));
      assert.equal(json.json.error.fix, expected);
      assert.ok(human.stderr.includes(`  fix:  ${expected}\n`));
      assert.doesNotMatch(json.stdout + json.stderr + human.stderr, /Idempotency-Key/i);
    }
  });

  it("masks a create key echoed in server errors", async () => {
    let key = "";
    const response: typeof fetch = async (url, options) => {
      key = new Headers(options?.headers).get("idempotency-key") ?? "";
      return reply(400, { code: "invalid_request", message: `Refused ${key}`, fix: `Correct ${key}.`, details: { reason: key } })(url, options);
    };
    for (const args of [[...share, "--json"], share]) {
      const result = await run([...args, "--verbose"], { fetch: response });
      assert.ok(key.length >= 20);
      assert.equal(result.code, 5);
      assert.ok(!(result.stdout + result.stderr).includes(key));
    }
  });
});
