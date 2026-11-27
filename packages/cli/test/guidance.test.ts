import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CliError, EXIT, LOCAL_FIX, type Phase, UPDATE_FIX } from "../src/errors.ts";
import { RECOGNISED_API_FIXES, type RecognisedFix, type SentCredential, cliFix, ttlFlagValue, utcTime } from "../src/guidance.ts";
import { GLOBAL, OPTIONS, PER_COMMAND, UNDOCUMENTED_OPTIONS } from "../src/main.ts";
import { errorDocument } from "../src/output.ts";
import { parseTtl } from "../src/ttl.ts";
import { type Hook, startFake } from "./fake-server.ts";
import { fileTempDir, run, writeTree } from "./helpers.ts";

const origin = "https://instahost.dev";
const docs = (code: string) => `${origin}/docs/api/#error-${code}`;
const dir = await fileTempDir();
const share = ["share", join(dir, "a.txt")];
const publish = ["publish", join(dir, "site")];
const remove = ["delete", "a".repeat(26), "--token", `ihd_${"D".repeat(43)}`];
await writeTree(dir, { "a.txt": "hello", "site/index.html": "<p>hello</p>" });

const API_KEY = `ihk_${"a".repeat(12)}_${"K".repeat(43)}`;
const DELETE_TOKEN = `ihd_${"T".repeat(43)}`;
const ARTIFACT = "b".repeat(26);
const RESETS_AT = "2026-11-28T00:00:00Z";
const ARTIFACT_FIX = " The artifact in `details.artifact` may exist: delete it with its `delete_token`.";
/** The API sentence a rewrite recognises (its current wording). */
const api = (rule: RecognisedFix): string => RECOGNISED_API_FIXES[rule][0];

const reply = (status: number, error: Record<string, unknown>): typeof fetch =>
  async () => new Response(JSON.stringify({ error }), { status });

type Command = "share" | "publish" | "delete";

/** One row of the approved wording table, run through the real CLI. */
interface Row {
  row: string;
  rule: RecognisedFix;
  command: Command;
  /** "complete": the API answers create normally and refuses complete (the publish phase). */
  at?: "complete";
  args: string[];
  env?: NodeJS.ProcessEnv;
  status: number;
  code: string;
  details?: Record<string, unknown>;
  exit: number;
  fix: string;
}

const PASS_KEY = "pass an API key with `--api-key` or `INSTAHOST_API_KEY`";
const ROWS: Row[] = [
  {
    row: "1", rule: "persistent_requires_api_key", command: "share", args: [...share, "--ttl", "never"], status: 403, code: "persistent_requires_api_key", exit: 4,
    fix: `Remove \`--ttl never\` to use the default lifetime, or keep it and ${PASS_KEY}.`,
  },
  {
    row: "2 (with a key)", rule: "persistence_disabled", command: "share", args: [...share, "--ttl", "never", "--api-key", API_KEY], status: 403, code: "forbidden", exit: 4,
    fix: "Remove `--ttl never` or replace it with a duration, because persistent artifacts are switched off; /v1/limits gives the longest lifetime.",
  },
  {
    row: "2 (anonymous)", rule: "persistence_disabled", command: "publish", args: [...publish, "--ttl", "never"], status: 403, code: "persistent_requires_api_key", exit: 4,
    fix: "Remove `--ttl never` or replace it with a duration, because persistent artifacts are switched off; /v1/limits gives the longest lifetime.",
  },
  {
    row: "3", rule: "anonymous_disabled", command: "share", args: share, status: 403, code: "anonymous_disabled", exit: 4,
    fix: "Pass an API key with `--api-key` or `INSTAHOST_API_KEY`, because anonymous uploads are switched off.",
  },
  {
    row: "4", rule: "anonymous_disabled_after_create", command: "share", at: "complete", args: share, status: 403, code: "anonymous_disabled", exit: 4,
    fix: "Run the command again with an API key (`--api-key` or `INSTAHOST_API_KEY`), because anonymous uploads are switched off.",
  },
  {
    row: "5", rule: "create_rate_limiter_unavailable", command: "publish", args: publish, status: 503, code: "service_misconfigured", details: { reason: "rate_limiter_unavailable" }, exit: 7,
    fix: `Run the command again later, or ${PASS_KEY}, because the rate limiter that anonymous uploads need is unavailable.`,
  },
  {
    row: "6", rule: "quota_exceeded", command: "share", args: share, status: 429, code: "quota_exceeded", details: { scope: "client", resets_at: RESETS_AT }, exit: 6,
    fix: `Wait until ${RESETS_AT} and run the command again, or ${PASS_KEY}, which has its own daily quota.`,
  },
  {
    row: "7", rule: "api_key_quota_exceeded", command: "publish", args: publish, env: { INSTAHOST_API_KEY: API_KEY }, status: 429, code: "quota_exceeded", details: { scope: "api_key", resets_at: RESETS_AT }, exit: 6,
    fix: `Wait until ${RESETS_AT}, when this API key's daily quota resets, then run the command again.`,
  },
  {
    row: "8a", rule: "ttl_too_long", command: "share", args: [...share, "--ttl", "8d"], status: 422, code: "ttl_too_long", details: { max_ttl_seconds: 604_800, min_ttl_seconds: 60 }, exit: 5,
    fix: `Use \`--ttl 7d\` or shorter, or ${PASS_KEY}, which has its own limit; see /v1/limits.`,
  },
  {
    row: "8b", rule: "ttl_too_long", command: "publish", args: [...publish, "--ttl", "91d"], env: { INSTAHOST_API_KEY: API_KEY }, status: 422, code: "ttl_too_long", details: { max_ttl_seconds: 7_776_000, min_ttl_seconds: 60 }, exit: 5,
    fix: "Use `--ttl 90d` or shorter; see /v1/limits.",
  },
  {
    row: "9", rule: "ttl_too_short", command: "share", args: [...share, "--ttl", "30"], status: 422, code: "ttl_too_short", details: { min_ttl_seconds: 60, max_ttl_seconds: 604_800 }, exit: 5,
    fix: "Use `--ttl 1m` or longer.",
  },
  {
    row: "10 (variable)", rule: "invalid_api_key", command: "share", args: share, env: { INSTAHOST_API_KEY: API_KEY }, status: 401, code: "invalid_api_key", exit: 4,
    fix: "Replace the API key in `INSTAHOST_API_KEY` with a valid, unrevoked one, or remove it to create anonymously.",
  },
  {
    row: "10 (flag)", rule: "invalid_api_key", command: "publish", args: [...publish, "--api-key", API_KEY], status: 401, code: "invalid_api_key", exit: 4,
    fix: "Replace the API key in `--api-key` with a valid, unrevoked one, or remove it to create anonymously.",
  },
  {
    row: "11 (variable)", rule: "invalid_api_key", command: "delete", args: ["delete", ARTIFACT], env: { INSTAHOST_API_KEY: API_KEY }, status: 401, code: "invalid_api_key", exit: 4,
    fix: "Pass the artifact's delete token with `--token`, or replace the API key in `INSTAHOST_API_KEY` with its owner's valid key.",
  },
  {
    row: "11 (flag)", rule: "invalid_api_key", command: "delete", args: ["delete", ARTIFACT, "--api-key", API_KEY], env: { INSTAHOST_DELETE_TOKEN: DELETE_TOKEN }, status: 401, code: "invalid_api_key", exit: 4,
    fix: "Pass the artifact's delete token with `--token`, or replace the API key in `--api-key` with its owner's valid key.",
  },
  ...([
    ["INSTAHOST_DELETE_TOKEN", [], { INSTAHOST_DELETE_TOKEN: DELETE_TOKEN, INSTAHOST_API_KEY: API_KEY }],
    ["--token", ["--token", DELETE_TOKEN], { INSTAHOST_DELETE_TOKEN: `ihd_${"U".repeat(43)}` }],
    ["--api-key", ["--api-key", API_KEY], { INSTAHOST_DELETE_TOKEN: DELETE_TOKEN }],
    ["INSTAHOST_API_KEY", [], { INSTAHOST_API_KEY: API_KEY }],
  ] as const).map(([source, flags, env]): Row => ({
    row: `12 (${source})`, rule: "forbidden", command: "delete", args: ["delete", ARTIFACT, ...flags], env, status: 403, code: "forbidden", exit: 4,
    fix: `Pass this artifact's own delete token with \`--token\`, or the API key that created it with \`--api-key\`, because the credential in \`${source}\` cannot manage it.`,
  })),
  {
    row: "13", rule: "invalid_request", command: "share", args: [...share, "--content-type", "Text/Plain"], status: 400, code: "invalid_request", details: { field: "files[0].content_type" }, exit: 5,
    fix: "Correct `--content-type` to a lowercase media type such as `text/plain`, or leave the option out.",
  },
  { row: "14 (invalid_request)", rule: "invalid_request", command: "share", args: share, status: 400, code: "invalid_request", details: { field: "files[0].md5" }, exit: 5, fix: UPDATE_FIX },
  { row: "14 (invalid_request, another content_type)", rule: "invalid_request", command: "share", args: [...share, "--content-type", "Text/Plain"], status: 400, code: "invalid_request", details: { field: "files[1].content_type" }, exit: 5, fix: UPDATE_FIX },
  { row: "14 (invalid_request, no field)", rule: "invalid_request", command: "publish", args: publish, status: 400, code: "invalid_request", exit: 5, fix: UPDATE_FIX },
  { row: "14 (invalid_request, publish phase)", rule: "invalid_request", command: "publish", at: "complete", args: publish, status: 400, code: "invalid_request", details: { field: "paths" }, exit: 5, fix: UPDATE_FIX },
  { row: "14 (invalid_json)", rule: "invalid_json", command: "share", args: share, status: 400, code: "invalid_json", exit: 5, fix: UPDATE_FIX },
  { row: "14 (unsupported_media_type)", rule: "unsupported_media_type", command: "publish", args: publish, status: 415, code: "unsupported_media_type", exit: 5, fix: UPDATE_FIX },
  { row: "14 (method_not_allowed)", rule: "method_not_allowed", command: "delete", args: remove, status: 405, code: "method_not_allowed", exit: 5, fix: UPDATE_FIX },
  { row: "14 (cross_site_request)", rule: "cross_site_request", command: "share", args: share, status: 403, code: "cross_site_request", exit: 4, fix: UPDATE_FIX },
  {
    row: "15", rule: "payload_too_large", command: "publish", args: publish, status: 413, code: "payload_too_large", details: { limit: 1_048_576 }, exit: 5,
    fix: "Publish fewer files or shorten their paths, because the file list is larger than the service accepts.",
  },
];

interface Outcome {
  json: Record<string, any>;
  stderr: string;
  code: number;
}

/** Runs one command in --json and in human mode; the API answers with `error` where the row says. */
async function attempt(row: Omit<Row, "fix">, apiFix: unknown, details: Record<string, unknown> | null = row.details ?? null): Promise<{ json: Outcome; human: Outcome; apiUrl: string }> {
  const error = { code: row.code, message: `Refused: ${row.row}.`, ...(details ? { details } : {}), fix: apiFix };
  if (row.at !== "complete") {
    const fetch = reply(row.status, { ...error, docs: docs(row.code) });
    const json = await run([...row.args, "--json"], { env: row.env, fetch });
    const human = await run(row.args, { env: row.env, fetch });
    return { json: { json: json.json, stderr: json.stderr, code: json.code }, human: { json: {}, stderr: human.stderr, code: human.code }, apiUrl: origin };
  }
  let apiUrl = "";
  const refuse: Hook = () => ({ status: row.status, body: { error: { ...error, docs: `${apiUrl}/docs/api/#error-${row.code}` } } });
  const fake = await startFake({ hooks: { complete: refuse }, apiKeys: [API_KEY] });
  apiUrl = fake.apiUrl;
  try {
    const json = await run([...row.args, "--json", "--api-url", apiUrl], { env: row.env });
    const human = await run([...row.args, "--api-url", apiUrl], { env: row.env });
    return { json: { json: json.json, stderr: json.stderr, code: json.code }, human: { json: {}, stderr: human.stderr, code: human.code }, apiUrl };
  } finally {
    await fake.stop();
  }
}

/** Asserts that both output modes carry `fix`, and that everything but `fix` is the API's. */
function assertFix(row: Omit<Row, "fix">, outcome: Awaited<ReturnType<typeof attempt>>, fix: string, details: Record<string, unknown> | null = row.details ?? null): void {
  const { json, human, apiUrl } = outcome;
  const label = `row ${row.row}`;
  assert.equal(json.code, row.exit, label);
  assert.equal(human.code, row.exit, label);
  assert.equal(json.stderr, "", label);
  const error = json.json.error as Record<string, unknown>;
  const artifact = row.at === "complete";
  assert.equal(error.fix, artifact ? fix + ARTIFACT_FIX : fix, label);
  assert.equal(error.code, row.code, label);
  assert.equal(error.message, `Refused: ${row.row}.`, label);
  assert.equal(error.docs, `${apiUrl}/docs/api/#error-${row.code}`, label);
  assert.equal(error.exit_code, row.exit, label);
  const { artifact: _created, ...rest } = (error.details ?? {}) as Record<string, unknown>;
  assert.deepEqual(rest, details ?? {}, label);
  assert.equal(artifact, _created !== undefined, label);
  const lines = human.stderr.split("\n");
  assert.ok(lines[0]?.startsWith(`instahost: Refused: ${row.row}.`), label);
  assert.ok(lines.includes(`  fix:  ${fix}`), `${label}: ${human.stderr}`);
  assert.ok(lines.includes(`  docs: ${apiUrl}/docs/api/#error-${row.code}`), label);
}

describe("the API's fix in CLI terms", () => {
  for (const row of ROWS) {
    it(`row ${row.row}: ${row.code} on ${row.command}${row.at ? ` (${row.at})` : ""}`, async () => {
      assertFix(row, await attempt(row, api(row.rule)), row.fix);
    });
  }

  it("passes through an unrecognised sentence for every rewritten code, in the phase it is rewritten in", async () => {
    for (const row of ROWS) {
      const fix = `A newer wording of the advice for ${row.code}.`;
      assertFix(row, await attempt(row, fix), fix);
    }
  });

  it("passes the API sentence through when a value it needs is missing or malformed", async () => {
    const bad: [string, string, unknown[]][] = [
      ["6", "resets_at", [undefined, null, "", "tomorrow", 1_764_288_000, "2026-11-28T00:00:00.000Z", "2026-11-28 00:00:00Z", "2026-11-28T00:00:00+00:00", "2026-02-30T00:00:00Z", "2026-11-28T24:00:00Z", " 2026-11-28T00:00:00Z"]],
      ["7", "resets_at", [undefined, "2026-11-28", "2026-13-01T00:00:00Z"]],
      ["8a", "max_ttl_seconds", [undefined, null, "604800", 0, -60, 1.5, 2 ** 53, 1e13, true]],
      ["8b", "max_ttl_seconds", [undefined, "7776000", -1]],
      ["9", "min_ttl_seconds", [undefined, "60", 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]],
    ];
    for (const [id, field, values] of bad) {
      const row = ROWS.find((r) => r.row === id) as Row;
      for (const value of values) {
        const details = { ...row.details };
        if (value === undefined) delete details[field];
        else details[field] = value;
        assertFix(row, await attempt(row, api(row.rule), details), api(row.rule), details);
      }
    }
    // An error without any details object at all.
    for (const id of ["6", "7", "8a", "8b", "9"]) {
      const row = ROWS.find((r) => r.row === id) as Row;
      assertFix(row, await attempt(row, api(row.rule), null), api(row.rule), null);
    }
  });

  it("never tells delete to create anonymously, and leaves a publish-phase forbidden as the API wrote it", async () => {
    for (const row of ROWS.filter((r) => r.command === "delete")) assert.doesNotMatch(row.fix, /anonym/i, row.row);
    const forbidden = { row: "forbidden on complete", rule: "forbidden", command: "share", at: "complete", args: share, env: { INSTAHOST_API_KEY: API_KEY }, status: 403, code: "forbidden", exit: 4 } as const;
    assertFix(forbidden, await attempt(forbidden, api("forbidden")), api("forbidden"));
    const invalidKey = { ...forbidden, row: "invalid_api_key on complete", rule: "invalid_api_key", status: 401, code: "invalid_api_key" } as const;
    assertFix(invalidKey, await attempt(invalidKey, api("invalid_api_key")), api("invalid_api_key"));
  });

  it("leaves the plan's pass-through sentences exactly as the API wrote them", async () => {
    // Literal API sentences (the service's ERROR_FIX and throw sites), as the 0.3.0 tests had them.
    const UNAUTHORIZED = "Send `Authorization: Bearer <token>`: the artifact's delete token or its owner's API key to manage it, an API key or no header at all to create.";
    const TOO_BIG_FOR_A_DAY = "Split the upload into smaller artifacts, because this create alone exceeds a daily quota; see /v1/limits.";
    const OWNER_KEY_REVOKED = "Create a new artifact with a valid API key; this one can no longer be uploaded to or published, only deleted.";
    const cases = [
      [{ row: "unauthorized on delete", rule: "forbidden", command: "delete", args: remove, status: 401, code: "unauthorized", exit: 4 }, UNAUTHORIZED],
      [{ row: "a create too big for a day", rule: "quota_exceeded", command: "share", args: share, status: 429, code: "quota_exceeded", details: { scope: "client", resets_at: RESETS_AT }, exit: 6 }, TOO_BIG_FOR_A_DAY],
      [{ row: "a revoked owner key on complete", rule: "forbidden", command: "share", at: "complete", args: share, env: { INSTAHOST_API_KEY: API_KEY }, status: 403, code: "forbidden", details: { reason: "owner_key_revoked" }, exit: 4 }, OWNER_KEY_REVOKED],
    ] as const;
    for (const [row, fix] of cases) {
      assertFix(row, await attempt(row, fix), fix);
      assert.ok(!Object.values(RECOGNISED_API_FIXES).flat().includes(fix as never), row.row);
    }
  });

  it("leaves create-only advice as the API wrote it on delete", async () => {
    // The 0.3.0 pass-through examples: each sentence is rewritten on create, never on delete.
    for (const rule of ["persistent_requires_api_key", "persistence_disabled", "anonymous_disabled", "anonymous_disabled_after_create", "create_rate_limiter_unavailable", "quota_exceeded", "api_key_quota_exceeded", "ttl_too_long", "ttl_too_short", "payload_too_large"] as const) {
      const row = { row: `${rule} on delete`, rule, command: "delete", args: remove, status: 403, code: "forbidden", details: { resets_at: RESETS_AT, max_ttl_seconds: 60, min_ttl_seconds: 60 }, exit: 4 } as const;
      assertFix(row, await attempt(row, api(rule)), api(rule));
    }
  });

  it("applies each rewrite only in its phases, and only with a credential source it can name", () => {
    const details = { resets_at: RESETS_AT, max_ttl_seconds: 604_800, min_ttl_seconds: 60, field: "files[0].content_type" };
    const phases: Record<RecognisedFix, readonly Phase[]> = {
      persistent_requires_api_key: ["create"],
      persistence_disabled: ["create"],
      anonymous_disabled: ["create"],
      anonymous_disabled_after_create: ["publish"],
      create_rate_limiter_unavailable: ["create"],
      quota_exceeded: ["create"],
      api_key_quota_exceeded: ["create"],
      ttl_too_long: ["create"],
      ttl_too_short: ["create"],
      invalid_api_key: ["create", "delete"],
      forbidden: ["delete"],
      invalid_request: ["create", "publish", "delete"],
      invalid_json: ["create", "publish", "delete"],
      unsupported_media_type: ["create", "publish", "delete"],
      method_not_allowed: ["create", "publish", "delete"],
      cross_site_request: ["create", "publish", "delete"],
      payload_too_large: ["create"],
    };
    assert.deepEqual(Object.keys(phases).sort(), Object.keys(RECOGNISED_API_FIXES).sort());
    for (const [rule, sentences] of Object.entries(RECOGNISED_API_FIXES) as [RecognisedFix, readonly string[]][]) {
      for (const phase of ["create", "publish", "delete"] as const) {
        const fix = cliFix(sentences[0], phase, details, "INSTAHOST_API_KEY");
        assert.equal(fix !== undefined, phases[rule].includes(phase), `${rule} in ${phase}`);
      }
    }
    for (const credential of [null, "unknown", "--token", "INSTAHOST_DELETE_TOKEN"] as SentCredential[]) {
      for (const phase of ["create", "delete"] as const) assert.equal(cliFix(api("invalid_api_key"), phase, undefined, credential), undefined, `${credential} ${phase}`);
    }
    for (const credential of [null, "unknown"] as SentCredential[]) assert.equal(cliFix(api("forbidden"), "delete", undefined, credential), undefined);
    // A key whose source is unknown was still sent: the anonymous advice to use a key is not given.
    assert.equal(cliFix(api("ttl_too_long"), "create", details, "unknown"), "Use `--ttl 7d` or shorter; see /v1/limits.");
    // The content-type rewrite is for create; elsewhere the field is a CLI bug.
    assert.equal(cliFix(api("invalid_request"), "publish", details, null), UPDATE_FIX);
    for (const value of [undefined, null, 42, "", "  ", api("forbidden").toUpperCase(), `${api("forbidden")} `]) assert.equal(cliFix(value, "delete", details, "--token"), undefined);
  });

  it("writes every rewrite as one sentence in CLI terms, with flags that apply to the command", async () => {
    const seen = new Set<RecognisedFix>();
    const commandOptions = (command: Command) => [...GLOBAL, ...(PER_COMMAND[command] ?? [])];
    // A create-phase rewrite can reach share and publish, except the --content-type one: only share
    // declares a content type. A publish-phase one is reached after either creates; delete's only there.
    const reach = (row: Row): Command[] => row.command === "delete" ? ["delete"] : row.row === "13" ? ["share"] : ["share", "publish"];
    for (const row of ROWS) {
      seen.add(row.rule);
      const { fix } = row;
      assert.ok(fix.length <= 500, row.row);
      assert.match(fix, /^(Correct|Pass|Publish|Remove|Replace|Run|Try|Use|Wait) [^]*\.$/, row.row);
      assert.doesNotMatch(fix, /\.\s|\n/, `${row.row}: one sentence`);
      assert.doesNotMatch(fix, /Authorization|Bearer|ttl_seconds|`persistent`|persistent:|--api-url|INSTAHOST_API_URL|Idempotency-Key|ih[dak]_/, row.row);
      for (const [flag] of fix.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)) {
        const name = flag.slice(2);
        assert.ok(Object.hasOwn(OPTIONS, name), `${row.row}: ${flag} is not an option`);
        assert.ok(!UNDOCUMENTED_OPTIONS.includes(name), `${row.row}: ${flag} is undocumented`);
        for (const command of reach(row)) assert.ok(commandOptions(command).includes(name), `${row.row}: ${flag} does not apply to ${command}`);
      }
      for (const [variable] of fix.matchAll(/\bINSTAHOST_[A-Z_]+/g)) {
        const allowed = row.command === "delete" ? ["INSTAHOST_API_KEY", "INSTAHOST_DELETE_TOKEN"] : ["INSTAHOST_API_KEY"];
        assert.ok(allowed.includes(variable), `${row.row}: ${variable} on ${row.command}`);
      }
      for (const [, ttl] of fix.matchAll(/`--ttl ([^`]+)`/g)) assert.doesNotThrow(() => parseTtl(ttl as string), row.row);
    }
    assert.deepEqual([...seen].sort(), Object.keys(RECOGNISED_API_FIXES).sort(), "every recognised sentence has a row");
  });

  it("lists each API sentence once, under one rewrite", () => {
    const all = Object.values(RECOGNISED_API_FIXES).flat();
    assert.equal(new Set(all).size, all.length);
    for (const sentence of all) {
      assert.ok(sentence.length > 0 && sentence.length <= 500);
      assert.equal(sentence, sentence.trim());
    }
  });

  it("writes seconds as the largest --ttl unit that divides them, and reads them back", () => {
    const cases: [number, string][] = [[1, "1"], [59, "59"], [60, "1m"], [90, "90"], [3600, "1h"], [5400, "90m"], [86_400, "1d"], [129_600, "36h"], [604_800, "7d"], [7_776_000, "90d"], [999_999_999_999, "999999999999"]];
    for (const [seconds, value] of cases) {
      assert.equal(ttlFlagValue(seconds), value);
      assert.deepEqual(parseTtl(value), { kind: "ttl", seconds });
    }
    for (let seconds = 1; seconds <= 200_000; seconds += 7) assert.deepEqual(parseTtl(ttlFlagValue(seconds) as string), { kind: "ttl", seconds });
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 1e13 + 1, "60", null, undefined, true]) assert.equal(ttlFlagValue(value), undefined, String(value));
  });

  it("accepts only real UTC times written as YYYY-MM-DDTHH:MM:SSZ", () => {
    for (const value of ["2026-11-28T00:00:00Z", "2024-02-29T23:59:59Z", "1970-01-01T00:00:00Z"]) assert.equal(utcTime(value), value);
    for (const value of ["2026-11-28T00:00:00.000Z", "2026-11-28T00:00:00z", "2026-11-28t00:00:00Z", "2025-02-29T00:00:00Z", "2026-11-28T23:60:00Z", "2026-11-28T00:00:60Z", "2026-11-28T00:00:00", "+002026-11-28T00:00:00Z", 1_764_288_000, null]) {
      assert.equal(utcTime(value), undefined, String(value));
    }
  });
});

describe("failure guidance", () => {
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
    // A sentence the CLI recognises does not displace the create-only guidance either.
    for (const [status, code, message, apiFix] of [
      [500, "internal_error", "The API could not create the artifact.", "Send the request with a new Idempotency-Key."],
      [409, "artifact_not_pending", "This Idempotency-Key's artifact is already published or failed.", "Send the request with a new Idempotency-Key."],
      [410, "gone", "This Idempotency-Key's artifact can no longer be replayed.", "Send the request with a new Idempotency-Key."],
      [500, "internal_error", "The API could not create the artifact.", RECOGNISED_API_FIXES.invalid_json[0]],
      [410, "gone", "This Idempotency-Key's artifact can no longer be replayed.", RECOGNISED_API_FIXES.payload_too_large[0]],
    ] as const) {
      const fetch = reply(status, { code, message, fix: apiFix, docs: docs(code) });
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
