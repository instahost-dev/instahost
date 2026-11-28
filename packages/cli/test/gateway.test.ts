import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { truncate } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Fake, type FakeOptions, startFake } from "./fake-server.ts";
import { fileTempDir, run, writeTree } from "./helpers.ts";

const OPERATOR_KEY = `ihk_abcdefghijkl_${"K".repeat(43)}`;
const dir = await fileTempDir();
const site = join(dir, "site");
const files = { "a.txt": "first", "index.html": "<p>site</p>", "z.bin": Buffer.from([0, 255, 3]) };
await writeTree(site, files);
const empty = join(dir, "empty.txt");
await writeTree(dir, { "empty.txt": "", "notes.txt": "notes" });
const notes = join(dir, "notes.txt");

async function withFake(options: FakeOptions, test: (fake: Fake) => Promise<void>): Promise<void> {
  const fake = await startFake(options);
  try {
    await test(fake);
  } finally {
    await fake.stop();
  }
}

const flags = (fake: Fake) => ["--json", "--api-url", fake.apiUrl];
const gatewayPuts = (fake: Fake) => fake.requests.filter((req) => req.server === "api" && req.method === "PUT");
const completeCalls = (fake: Fake) => fake.requests.filter((req) => req.path.endsWith("/complete"));
const creates = (fake: Fake) => fake.requests.filter((req) => req.method === "POST" && req.path === "/v1/artifacts");

function assertGatewayOnly(fake: Fake): void {
  assert.equal(fake.artifacts.size, 1);
  assert.equal(fake.requests.some((req) => req.server === "s3" || req.path.endsWith("/uploads")), false);
}

function assertPresignedOnly(fake: Fake): void {
  assert.equal(fake.artifacts.size, 1);
  assert.equal(gatewayPuts(fake).length, 0);
  const puts = fake.requests.filter((req) => req.server === "s3" && req.method === "PUT");
  assert.equal(puts.length, [...fake.artifacts.values()][0]!.files.length);
  for (const put of puts) assert.equal(put.headers.authorization, undefined);
}

describe("gateway upload instructions", () => {
  it("shares an empty file with Content-Length 0 and completes with the delete token", async () => {
    await withFake({ gateway: { force: true } }, async (fake) => {
      const result = await run(["share", empty, ...flags(fake)]);
      assert.equal(result.code, 0, result.stdout);
      assertGatewayOnly(fake);
      assert.equal(result.json.total_bytes, 0);
      assert.equal(JSON.parse(creates(fake)[0]!.body.toString()).upload_protocol, undefined);
      const artifact = fake.artifacts.get(result.json.id)!;
      const [put] = gatewayPuts(fake);
      assert.equal(put?.path, `/v1/upload-gateway/${artifact.id}/files/0`);
      assert.equal(put?.headers.authorization, `Bearer ${artifact.gateway?.credential}`);
      assert.equal(put?.headers["content-length"], "0");
      assert.equal(put?.headers["content-encoding"], undefined);
      assert.deepEqual(put?.body, Buffer.alloc(0));
      assert.equal(completeCalls(fake)[0]?.headers.authorization, `Bearer ${result.json.delete_token}`);
    });
  });

  it("publishes with bounded concurrency and exact manifest indices, bytes and credentials", async () => {
    await withFake({ gateway: { force: true }, apiKeys: [OPERATOR_KEY], putDelayMs: 50 }, async (fake) => {
      const result = await run(["publish", site, "--concurrency", "2", "--api-key", OPERATOR_KEY, ...flags(fake)]);
      assert.equal(result.code, 0, result.stdout);
      assertGatewayOnly(fake);
      assert.equal(result.json.file_count, 3);
      assert.equal(fake.maxConcurrentPuts, 2);
      const artifact = fake.artifacts.get(result.json.id)!;
      const puts = gatewayPuts(fake);
      assert.equal(puts.length, artifact.files.length);
      const byPath = new Map(puts.map((put) => [put.path, put]));
      for (const [index, file] of artifact.files.entries()) {
        const put = byPath.get(`/v1/upload-gateway/${artifact.id}/files/${index}`);
        assert.ok(put);
        assert.deepEqual(put.body, Buffer.from(files[file.path as keyof typeof files]));
        assert.equal(put.headers["content-length"], String(file.size));
        assert.equal(put.headers["content-encoding"], undefined);
        assert.equal(put.headers.authorization, `Bearer ${artifact.gateway?.credential}`);
      }
      assert.equal(completeCalls(fake)[0]?.headers.authorization, `Bearer ${OPERATOR_KEY}`);
    });
  });

  it("repeats an indexed PUT whose stored response was lost and repairs a missing path at its original index", async () => {
    await withFake({
      gateway: { force: true },
      hooks: {
        gatewayPut: (_req, ctx) => ctx.path === "a.txt" && ctx.attempt === 1 ? "drop-after-put" : null,
        complete: (_req, ctx) => ctx.attempt === 1
          ? { status: 409, body: { error: { code: "upload_incomplete", details: { missing: ["z.bin"], missing_count: 1 } } } }
          : null,
      },
    }, async (fake) => {
      const result = await run(["publish", site, ...flags(fake)]);
      assert.equal(result.code, 0, result.stdout);
      assertGatewayOnly(fake);
      assert.deepEqual(result.sleeps, [1]);
      const artifact = fake.artifacts.get(result.json.id)!;
      const putIndices = gatewayPuts(fake).map((put) => Number(put.path.split("/").at(-1)));
      assert.deepEqual(putIndices.slice().sort(), [0, 0, 1, 2, 2]);
      assert.equal(putIndices.at(-1), artifact.files.findIndex((file) => file.path === "z.bin"));
      assert.equal(completeCalls(fake).length, 2);
    });
  });

  it("honors Retry-After for transient errors within the retry and upload windows", async () => {
    await withFake({
      gateway: { force: true },
      hooks: { gatewayPut: (_req, ctx) => {
        if (ctx.attempt === 1) return { status: 429, headers: { "retry-after": "6" }, body: { error: { code: "rate_limited" } } };
        if (ctx.attempt === 2) return { status: 503, headers: { "retry-after": "7" } };
        return null;
      } },
    }, async (fake) => {
      const result = await run(["share", notes, ...flags(fake)]);
      assert.equal(result.code, 0, result.stdout);
      assertGatewayOnly(fake);
      assert.deepEqual(result.sleeps, [6, 7]);
      assert.equal(gatewayPuts(fake).length, 3);
    });
    for (const [ttlSeconds, retryAfter] of [[10, 15], [900, 61]] as const) {
      await withFake({
        gateway: { force: true, ttlSeconds },
        hooks: { gatewayPut: () => ({ status: 429, headers: { "retry-after": String(retryAfter) }, body: { error: { code: "rate_limited" } } }) },
      }, async (fake) => {
        const result = await run(["share", notes, ...flags(fake)]);
        assert.deepEqual([result.code, result.json.error.code], [6, "rate_limited"]);
        assertGatewayOnly(fake);
        assert.deepEqual(result.sleeps, []);
        assert.equal(gatewayPuts(fake).length, 1);
      });
    }
  });

  it("stops at expiry without sending bytes", async () => {
    await withFake({ gateway: { force: true, ttlSeconds: -1 } }, async (fake) => {
      const result = await run(["share", notes, ...flags(fake)]);
      assert.deepEqual([result.code, result.json.error.code], [8, "upload_ended"]);
      assertGatewayOnly(fake);
      assert.equal(gatewayPuts(fake).length, 0);
      assert.equal(completeCalls(fake).length, 0);
      assert.ok(result.json.error.details.artifact.delete_token);
    });
  });

  it("keeps file-change checks and surfaces a checksum mismatch without retrying", async () => {
    for (const [replacement, exit, code, puts] of [["bigger", 3, "file_changed", 0], ["other", 8, "checksum_mismatch", 1]] as const) {
      const file = join(dir, "changing.txt");
      writeFileSync(file, "notes");
      await withFake({
        gateway: { force: true },
        hooks: { create: () => { writeFileSync(file, replacement); return null; } },
      }, async (fake) => {
        const result = await run(["share", file, ...flags(fake)]);
        assert.deepEqual([result.code, result.json.error.code], [exit, code]);
        assertGatewayOnly(fake);
        assert.deepEqual(result.sleeps, []);
        assert.equal(gatewayPuts(fake).length, puts);
        assert.equal(completeCalls(fake).length, 0);
      });
    }
  });

  it("redacts the upload credential echoed in failure details and verbose output", async () => {
    await withFake({
      gateway: { force: true },
      hooks: {
        gatewayPut: (_req, { artifact }) => {
          const token = artifact!.gateway!.credential;
          return { status: 410, body: { error: { code: "upload_ended", message: `expired ${token}`, details: { [token]: token }, fix: `Do not use ${token}` } } };
        },
      },
    }, async (fake) => {
      const result = await run(["share", notes, "--verbose", ...flags(fake)]);
      const artifact = fake.artifacts.get(result.json.error.details.artifact.id)!;
      assert.deepEqual([result.code, result.json.error.code], [8, "upload_ended"]);
      assertGatewayOnly(fake);
      assert.equal(result.json.error.details.artifact.delete_token, artifact.deleteToken);
      assert.equal((result.stdout + result.stderr).includes(artifact.gateway!.credential), false);
      assert.match(result.stdout, /ihu_\*\*\*/);
      assert.match(result.stderr, /api PUT.*410/);
      assert.equal(gatewayPuts(fake).length, 1);
    });
  });

  it("refuses cross-origin data, status and complete URLs before sending a credential", async () => {
    const other = "http://127.0.0.1:1";
    for (const options of [
      { gateway: { force: true, dataOrigin: other } },
      { gateway: { force: true, statusOrigin: other } },
      { gateway: { force: true }, advertisedOrigin: other },
    ]) {
      await withFake(options, async (fake) => {
        const result = await run(["share", notes, ...flags(fake)]);
        assert.deepEqual([result.code, result.json.error.code], [7, "unsafe_url"]);
        assertGatewayOnly(fake);
        assert.deepEqual(fake.requests.map((req) => req.method), ["GET", "POST"]);
      });
    }
  });

  it("refuses redirects from a gateway PUT or complete", async () => {
    for (const step of ["gatewayPut", "complete"] as const) {
      let destination: string;
      await withFake({
        gateway: { force: true },
        hooks: { [step]: () => ({ status: 307, headers: { location: destination } }) },
      }, async (fake) => {
        destination = `${fake.s3Url}/redirect-target`;
        const result = await run(["share", notes, ...flags(fake)]);
        assert.deepEqual([result.code, result.json.error.code], [7, "network_error"]);
        assertGatewayOnly(fake);
      });
    }
  });
});

const LIMIT = 104_857_600;
const gateway = { limits: { anonymous: true, api_key: true, single_request_max_bytes: LIMIT }, admission: "all" } as const;
const ACCOUNT_KEY = `ihk_abcdefghijkm_${"A".repeat(43)}`;
const createBodies = (fake: Fake) => creates(fake).map((req) => JSON.parse(req.body.toString()));
const createProtocols = (fake: Fake) => createBodies(fake).map((body) => body.upload_protocol);
const apiError = (status: number, code: string) => ({ status, body: { error: { code } } });

describe("choosing a protocol for create", () => {
  it("selects the gateway for keyless share and operator-key publish using public limits", async () => {
    for (const [command, path, key] of [["share", notes, null], ["publish", site, OPERATOR_KEY]] as const) {
      await withFake({ gateway, apiKeys: [OPERATOR_KEY] }, async (fake) => {
        const result = await run([command, path, ...flags(fake), ...(key ? ["--api-key", key] : [])]);
        assert.equal(result.code, 0, result.stdout);
        assertGatewayOnly(fake);
        assert.deepEqual(createProtocols(fake), ["gateway-v1"]);
        const [limits] = fake.requests;
        assert.deepEqual([limits?.method, limits?.path, limits?.headers.authorization], ["GET", "/v1/limits", undefined]);
        assert.equal(gatewayPuts(fake).length, result.json.file_count);
      });
    }
  });

  it("uses the per-file limit for a mixed-size site, including the exact cap and one byte over", async () => {
    const largeSite = join(dir, "large-site");
    await writeTree(largeSite, { "index.html": "<p>large site</p>", "asset.bin": "" });
    for (const size of [LIMIT, LIMIT + 1]) {
      await truncate(join(largeSite, "asset.bin"), size);
      await withFake({ gateway }, async (fake) => {
        const result = await run(["publish", largeSite, ...flags(fake)]);
        assert.equal(result.code, 0, result.stdout);
        assert.ok(result.json.total_bytes > LIMIT);
        assert.equal(createBodies(fake)[0].files.find((file: { path: string }) => file.path === "asset.bin").size, size);
        assert.deepEqual(createProtocols(fake), [size === LIMIT ? "gateway-v1" : undefined]);
        if (size === LIMIT) {
          assertGatewayOnly(fake);
          assert.ok(gatewayPuts(fake).some((put) => put.body.length === LIMIT));
        } else {
          assertPresignedOnly(fake);
        }
      });
    }
  });

  it("uses legacy when discovery is missing, unavailable or disabled for the caller", async () => {
    for (const options of [
      {},
      { hooks: { limits: () => apiError(404, "not_found") } },
      { hooks: { limits: () => apiError(503, "service_unavailable") } },
      { gateway: { ...gateway, limits: { ...gateway.limits, anonymous: false } } },
    ]) {
      await withFake(options, async (fake) => {
        const result = await run(["share", notes, ...flags(fake)]);
        assert.equal(result.code, 0, result.stdout);
        assert.deepEqual(result.sleeps, []);
        assertPresignedOnly(fake);
        assert.deepEqual(createProtocols(fake), [undefined]);
      });
    }
    await withFake({ gateway: { ...gateway, limits: { ...gateway.limits, api_key: false } }, apiKeys: [OPERATOR_KEY] }, async (fake) => {
      const result = await run(["share", notes, "--api-key", OPERATOR_KEY, ...flags(fake)]);
      assert.equal(result.code, 0, result.stdout);
      assertPresignedOnly(fake);
      assert.deepEqual(createProtocols(fake), [undefined]);
    });
  });

  it("falls back once on a definite pre-create protocol refusal, preserving auth and the manifest", async () => {
    const cases: { options: FakeOptions; key?: string }[] = [
      { options: { gateway: { ...gateway, accountKeys: [ACCOUNT_KEY] } }, key: ACCOUNT_KEY },
      { options: { gateway: { ...gateway, admission: "off" } } },
      ...([[400, "upload_protocol_unsupported"], [413, "gateway_file_too_large"]] as const).map(([status, code]): { options: FakeOptions } => ({
        options: { gateway, hooks: { create: (_req, { attempt }) => attempt === 1 ? apiError(status, code) : null } },
      })),
    ];
    for (const { options, key } of cases) {
      await withFake(options, async (fake) => {
        const result = await run(["publish", site, ...flags(fake), ...(key ? ["--api-key", key] : [])]);
        assert.equal(result.code, 0, result.stdout);
        assertPresignedOnly(fake);
        assert.deepEqual(createProtocols(fake), ["gateway-v1", undefined]);
        const [{ upload_protocol: _, ...first }, second] = createBodies(fake);
        assert.deepEqual(first, second);
        const requests = creates(fake);
        assert.deepEqual(requests.map((req) => req.headers.authorization), Array(2).fill(key ? `Bearer ${key}` : undefined));
        assert.equal(new Set(requests.map((req) => req.headers["idempotency-key"])).size, 2);
      });
    }
  });

  it("replays a lost gateway create with identical bytes and idempotency key", async () => {
    await withFake({
      gateway,
      hooks: { create: (_req, { attempt }) => attempt === 1 ? "drop-after-create" : null },
    }, async (fake) => {
      const result = await run(["share", notes, ...flags(fake)]);
      assert.equal(result.code, 0, result.stdout);
      assertGatewayOnly(fake);
      assert.deepEqual(createProtocols(fake), ["gateway-v1", "gateway-v1"]);
      assert.deepEqual(result.sleeps, [1]);
      const [first, second] = creates(fake);
      assert.ok(first?.headers["idempotency-key"]);
      assert.equal(first.headers["idempotency-key"], second?.headers["idempotency-key"]);
      assert.deepEqual(first.body, second?.body);
      assert.equal(completeCalls(fake).length, 1);
    });
  });

  it("keeps the original protocol if a create refusal follows a lost or 5xx response", async () => {
    for (const firstReply of ["drop-after-create", apiError(503, "service_unavailable")] as const) {
      await withFake({
        gateway,
        hooks: { create: (_req, { attempt }) => attempt === 1 ? firstReply : apiError(409, "upload_protocol_unavailable") },
      }, async (fake) => {
        const result = await run(["share", notes, ...flags(fake)]);
        assert.deepEqual([result.code, result.json.error.code], [5, "upload_protocol_unavailable"]);
        assert.deepEqual(createProtocols(fake), ["gateway-v1", "gateway-v1"]);
        assert.equal(new Set(creates(fake).map((req) => req.headers["idempotency-key"])).size, 1);
        assert.equal(fake.artifacts.size, firstReply === "drop-after-create" ? 1 : 0);
        assert.equal(fake.requests.some((req) => req.method === "PUT"), false);
      });
    }
  });

  it("stops on auth or quota refusal, malformed create, or a refusal after create", async () => {
    const cases: { hooks: FakeOptions["hooks"]; key?: string; code: string; artifacts: number }[] = [
      { hooks: {}, key: OPERATOR_KEY, code: "invalid_api_key", artifacts: 0 },
      { hooks: { create: () => apiError(429, "quota_exceeded") }, code: "quota_exceeded", artifacts: 0 },
      { hooks: { create: () => "malformed-after-create" }, code: "bad_response", artifacts: 1 },
      { hooks: { complete: () => apiError(409, "upload_protocol_unavailable") }, code: "upload_protocol_unavailable", artifacts: 1 },
    ];
    for (const { hooks, key, code, artifacts } of cases) {
      await withFake({ gateway, hooks }, async (fake) => {
        const result = await run(["share", notes, ...flags(fake), ...(key ? ["--api-key", key] : [])]);
        assert.equal(result.json.error.code, code);
        assert.deepEqual(createProtocols(fake), ["gateway-v1"]);
        assert.equal(fake.artifacts.size, artifacts);
        assert.equal(fake.requests.some((req) => req.server === "s3"), false);
      });
    }
  });
});
