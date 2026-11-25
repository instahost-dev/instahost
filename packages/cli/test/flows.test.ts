// Full share, publish and delete flows against the in-process fake API and fake S3: batching,
// concurrency, 412, 403 re-issue, retries, upload_incomplete, credential hygiene and the exit code
// of every failure class.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Fake, type FakeOptions, startFake } from "./fake-server.ts";
import { fileTempDir, md5, run, tempDir, writeTree } from "./helpers.ts";

const API_KEY = `ihk_abcdefghijkl_${"K".repeat(43)}`;
const dir = await fileTempDir();
const site: Record<string, string> = { "index.html": '<link rel="stylesheet" href="css/a.css"><p>site</p>', "css/a.css": "p{color:red}", ".env": "SECRET=1" };
for (let i = 0; i < 118; i++) site[`assets/f${String(i).padStart(3, "0")}.txt`] = `file ${i}\n`;
await writeTree(join(dir, "site"), site);
await writeTree(dir, { "photo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), "notes.txt": "hello" });

async function withFake<T>(options: FakeOptions, fn: (fake: Fake) => Promise<T>): Promise<T> {
  const fake = await startFake(options);
  try {
    return await fn(fake);
  } finally {
    await fake.stop();
  }
}

const apiRequests = (fake: Fake, pathPart: string, method = "POST") => fake.requests.filter((r) => r.server === "api" && r.method === method && r.path.includes(pathPart));
const puts = (fake: Fake) => fake.requests.filter((r) => r.server === "s3");
/** PUTs of one manifest path (object keys are t/<id>/<index in the manifest>). */
const putsFor = (fake: Fake, path: string) => {
  const artifact = [...fake.artifacts.values()].at(-1);
  const idx = artifact?.files.findIndex((f) => f.path === path) ?? -1;
  return puts(fake).filter((p) => new URL(p.path, "http://x").pathname.endsWith(`/${artifact?.id}/${idx}`));
};

describe("credentials for /uploads and /complete", () => {
  it("uses the creating API key when there is one, else the delete token", async () => {
    const many: Record<string, string> = { "index.html": "<p>i</p>" };
    for (let i = 0; i < 60; i++) many[`f${i}.txt`] = `f${i}`;
    const site = join(dir, "manage-site");
    await writeTree(site, many);
    for (const key of [API_KEY, null]) {
      await withFake({ apiKeys: [API_KEY], batchSize: 50 }, async (fake) => {
        const r = await run(["publish", site, "--json", "--api-url", fake.apiUrl, ...(key ? ["--api-key", key] : [])]);
        assert.equal(r.code, 0, r.stdout);
        const manage = fake.requests.filter((q) => q.server === "api" && /\/(uploads|complete)$/.test(new URL(q.path, "http://x").pathname));
        assert.ok(manage.some((q) => q.path.endsWith("/uploads")) && manage.some((q) => q.path.endsWith("/complete")));
        for (const q of manage) assert.equal(q.headers.authorization, `Bearer ${key ?? r.json.delete_token}`, q.path);
      });
    }
  });
});

describe("share", () => {
  it("uploads one file and prints one JSON document; credentials only ever go to the API origin", async () => {
    await withFake({ apiKeys: [API_KEY] }, async (fake) => {
      const r = await run(["share", join(dir, "photo.png"), "--json", "--api-url", fake.apiUrl, "--api-key", API_KEY, "--ttl", "2h"]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.stderr, "");
      const doc = r.json;
      assert.equal(doc.ok, true);
      assert.equal(doc.type, "file");
      assert.match(doc.delete_token, /^ihd_/);
      assert.equal(doc.access_token, null);
      assert.deepEqual(doc.skipped, []);
      const create = apiRequests(fake, "/v1/artifacts")[0];
      assert.ok(create);
      const body = JSON.parse(create.body.toString());
      assert.deepEqual(body, { type: "file", access: "unlisted", ttl_seconds: 7200, files: [{ path: "photo.png", size: 7, md5: md5(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])) }] });
      assert.equal(create.headers.authorization, `Bearer ${API_KEY}`);
      assert.match(String(create.headers["user-agent"]), /^instahost-cli\/\d+\.\d+\.\d+ \(node\/\d+/);
      for (const put of puts(fake)) {
        assert.equal(put.headers.authorization, undefined);
        assert.equal(put.headers["content-length"], "7");
        assert.equal(put.headers.expect, undefined);
        assert.equal(put.headers["if-none-match"], "*");
      }
      // Managing calls use the API key that created the artifact (so the key's rate limits apply).
      assert.equal(apiRequests(fake, "/complete")[0]?.headers.authorization, `Bearer ${API_KEY}`);
    });
  });

  it("returns the access token and URL for a private share, and --name and --content-type reach the manifest", async () => {
    await withFake({}, async (fake) => {
      const r = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl, "--access", "private", "--name", "readme.txt", "--content-type", "text/markdown"]);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.json.access_token, /^iha_/);
      assert.match(r.json.access_url, /\?token=iha_/);
      const body = JSON.parse(apiRequests(fake, "/v1/artifacts")[0]?.body.toString() ?? "{}");
      assert.deepEqual(body.files[0], { path: "readme.txt", size: 5, md5: "5d41402abc4b2a76b9719d911017c592", content_type: "text/markdown" });
    });
  });

  it("human mode prints URL, Expires and Delete on stdout and nothing else", async () => {
    await withFake({}, async (fake) => {
      const r = await run(["share", join(dir, "notes.txt"), "--api-url", fake.apiUrl]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /^URL {6}http:\/\/files\.localhost:9\/[a-z2-7]{26}\/notes\.txt\nExpires {2}2026-11-22T00:00:00Z\nDelete {3}npx -y @instahost\/cli delete [a-z2-7]{26} --token ihd_\S+\n$/);
      assert.equal(r.stderr, "");
    });
  });

  it("refuses sensitive names, symlinks, directories and missing files locally (exit 3), before any request", async () => {
    await withFake({}, async (fake) => {
      const { dir: d, cleanup: done } = await tempDir();
      try {
        await writeTree(d, { ".env.production": "x", "keys/server.key": "x", ".ssh/config": "x", "ok.txt": "x", "dir/a.txt": "x" });
        const { symlink } = await import("node:fs/promises");
        await symlink(join(d, "ok.txt"), join(d, "link.txt"));
        const cases: [string[], string][] = [
          [[join(d, ".env.production")], "sensitive_file"],
          [[join(d, "keys/server.key")], "sensitive_file"],
          [[join(d, ".ssh/config")], "sensitive_file"],
          [[join(d, "ok.txt"), "--name", "id_ed25519"], "sensitive_file"],
          [[join(d, "link.txt")], "symlink_refused"],
          [[join(d, "dir")], "not_a_file"],
          [[join(d, "missing.txt")], "file_not_found"],
          [[join(d, "ok.txt"), "--name", "a/b.txt"], "invalid_path"],
          [[join(d, "ok.txt"), "--name", "bad​name.txt"], "invalid_path"],
        ];
        for (const [args, code] of cases) {
          const r = await run(["share", ...args, "--json", "--api-url", fake.apiUrl]);
          assert.equal(r.code, 3, `${args.join(" ")}: ${r.stdout}`);
          assert.equal(r.json.error.code, code, args.join(" "));
          assert.equal(r.json.error.exit_code, 3);
        }
        assert.equal(fake.requests.length, 0);
      } finally {
        await done();
      }
    });
  });
});

describe("publish", () => {
  it("previews the publish manifest and skips without contacting the API or storage", async () => {
    const target = join(dir, "preview-site");
    const index = '<script src="/app.js"></script>';
    await writeTree(target, { "index.html": index, "app.js": "1", ".hidden": "h", ".env": "SECRET=1", ".DS_Store": "metadata" });
    await withFake({}, async (fake) => {
      const args = ["publish", target, "--json", "--api-url", fake.apiUrl];
      const preview = await run([...args, "--dry-run"]);
      assert.deepEqual([preview.code, preview.stderr], [0, ""], preview.stdout);
      const { warnings, ...plan } = preview.json;
      assert.deepEqual(plan, {
        ok: true,
        dry_run: true,
        type: "site",
        files: [{ path: "app.js", size: 1 }, { path: "index.html", size: Buffer.byteLength(index) }],
        file_count: 2,
        total_bytes: 1 + Buffer.byteLength(index),
        skipped: [{ path: ".DS_Store", reason: "os_metadata" }, { path: ".env", reason: "sensitive" }, { path: ".hidden", reason: "dotfile" }],
      });
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].code, "root_absolute_reference");
      assert.match(warnings[0].message, /can break when a site is served under a path/);
      assert.deepEqual(warnings[0].paths, ["index.html"]);

      const withDotfiles = await run([...args, "--dry-run", "--include-dotfiles"]);
      assert.equal(withDotfiles.code, 0, withDotfiles.stdout);
      assert.deepEqual(withDotfiles.json.files, [{ path: ".hidden", size: 1 }, ...plan.files]);
      assert.equal(fake.requests.length, 0);

      const published = await run([...args, "--include-dotfiles"]);
      assert.equal(published.code, 0, published.stdout);
      const create = apiRequests(fake, "/v1/artifacts")[0];
      assert.ok(create);
      const files = JSON.parse(create.body.toString()).files as { path: string; size: number }[];
      assert.deepEqual(files.map(({ path, size }) => ({ path, size })), withDotfiles.json.files);
      assert.deepEqual(published.json.skipped, withDotfiles.json.skipped);
    });
  });

  it("prints a human preview: included files on stdout, skipped paths on stderr", async () => {
    const target = join(dir, "human-preview");
    await writeTree(target, { "index.html": "hello", ".env": "SECRET=1" });
    await withFake({}, async (fake) => {
      const preview = await run(["publish", target, "--dry-run", "--api-url", fake.apiUrl], { tty: true });
      assert.equal(preview.code, 0, preview.stderr);
      assert.equal(preview.stdout, "Dry run: would publish 1 file(s) (5 bytes). Nothing uploaded.\n  index.html  (5 bytes)\n");
      assert.equal(preview.stderr, "skipped  .env  (looks like a credential or VCS data)\n");
      assert.equal(fake.requests.length, 0);
    });
  });

  it("refuses malformed API settings exactly as a publish does, so a passing preview means the publish passes them too", async () => {
    await withFake({}, async (fake) => {
      const cases: [string[], NodeJS.ProcessEnv][] = [
        [["--api-url", fake.apiUrl, "--api-key", "invalid"], {}],
        [["--api-url", fake.apiUrl], { INSTAHOST_API_KEY: "invalid" }],
        [[], { INSTAHOST_API_URL: "invalid" }],
      ];
      for (const [flags, env] of cases) {
        const published = await run(["publish", join(dir, "site"), "--json", ...flags], { env });
        assert.deepEqual([published.code, published.json.error.code], [2, "usage"], published.stdout);
        const preview = await run(["publish", join(dir, "site"), "--json", "--dry-run", ...flags], { env });
        assert.deepEqual([preview.code, preview.json], [published.code, published.json]);
      }
      assert.equal(fake.requests.length, 0);
    });
  });

  it("uploads in batches requested just before use, at most --concurrency at a time, skipping sensitive files", async () => {
    await withFake({ batchSize: 50 }, async (fake) => {
      const r = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl, "--concurrency", "4"]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(r.json.file_count, 120);
      assert.deepEqual(r.json.skipped, [{ path: ".env", reason: "sensitive" }]);
      assert.deepEqual(r.json.warnings, []);
      const create = JSON.parse(apiRequests(fake, "/v1/artifacts")[0]?.body.toString() ?? "{}");
      assert.equal(create.files.length, 120);
      assert.ok(!create.files.some((f: { path: string }) => f.path === ".env"));
      // 50 URLs from create, then two /uploads calls (50 + 20), each after the previous batch.
      const uploads = apiRequests(fake, "/uploads");
      assert.deepEqual(uploads.map((u) => JSON.parse(u.body.toString()).paths.length), [50, 20]);
      const order = fake.requests.map((q) => (q.server === "s3" ? "put" : q.path.includes("/uploads") ? "uploads" : "other"));
      assert.equal(order.indexOf("uploads"), order.indexOf("put") + 50);
      assert.equal(puts(fake).length, 120);
      assert.ok(fake.maxConcurrentPuts <= 4 && fake.maxConcurrentPuts >= 2, `max in flight ${fake.maxConcurrentPuts}`);
      assert.equal(apiRequests(fake, "/complete").length, 1);
    });
  });

  it("warns about root-absolute URLs when the site lives under a path", async () => {
    await withFake({}, async (fake) => {
      const { dir: d, cleanup: done } = await tempDir();
      try {
        await writeTree(d, { "index.html": '<script src="/app.js"></script>', "app.js": "1" });
        const r = await run(["publish", d, "--json", "--api-url", fake.apiUrl]);
        assert.equal(r.code, 0);
        assert.equal(r.json.warnings[0].code, "root_absolute_reference");
        assert.deepEqual(r.json.warnings[0].paths, ["index.html"]);
      } finally {
        await done();
      }
    });
  });

  it("counts 412 as already uploaded", async () => {
    await withFake({ hooks: { put: (_r, c) => (c.path === "css/a.css" && c.attempt === 1 ? { status: 412, body: "<Error><Code>PreconditionFailed</Code></Error>" } : null) } }, async (fake) => {
      // The fake keeps no object for the 412, so complete reports it missing and the CLI uploads it again.
      const r = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(apiRequests(fake, "/complete").length, 2);
    });
  });

  it("re-issues the batch's URLs once on 403 (one /uploads call), then retries", async () => {
    await withFake({ hooks: { put: (_r, c) => (c.attempt === 1 && c.path?.startsWith("assets/f00") ? { status: 403, body: "<Error><Code>AccessDenied</Code></Error>" } : null) } }, async (fake) => {
      const r = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl, "--concurrency", "6"]);
      assert.equal(r.code, 0, r.stdout);
      // The 403s that arrive together share a re-issue call; each refused file is re-issued once.
      const uploads = apiRequests(fake, "/uploads");
      assert.ok(uploads.length >= 3 && uploads.length <= 5, `${uploads.length} /uploads calls`);
      const artifact = [...fake.artifacts.values()][0];
      for (const f of artifact?.files ?? []) assert.equal(f.issued, f.path.startsWith("assets/f00") ? 2 : 1, f.path);
    });
  });

  it("uses a URL that was short-lived from the start as it is (a new one would be no longer)", async () => {
    await withFake({ urlTtlSeconds: 2 }, async (fake) => {
      const r = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 0, r.stdout);
      assert.equal(apiRequests(fake, "/uploads").length, 0); // 2 s of life, under the 5 s minimum, but issued that way
    });
  });

  it("fails with exit 7 when a URL is still refused after the re-issue", async () => {
    await withFake({ hooks: { put: (_r, c) => (c.path === "index.html" ? { status: 403, body: "<Error><Code>AccessDenied</Code></Error>" } : null) } }, async (fake) => {
      const r = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 7);
      assert.equal(r.json.error.code, "upload_failed");
      assert.deepEqual({ ...r.json.error.details, artifact: undefined }, { path: "index.html", status: 403, s3_code: "AccessDenied", artifact: undefined });
      assert.match(r.json.error.details.artifact.delete_token, /^ihd_/); // the artifact exists: it can still be deleted
      assert.equal(apiRequests(fake, "/complete").length, 0);
    });
  });

  it("retries 5xx, 429 and dropped connections up to 3 times, waiting 1, 2 and 4 s", async () => {
    const plan: Record<string, (number | "drop")[]> = { "index.html": [500, 503], "css/a.css": ["drop"], "assets/f000.txt": [429, 502, 500] };
    await withFake(
      {
        hooks: {
          put: (_r, c) => {
            const step = plan[c.path ?? ""]?.[c.attempt - 1];
            return step === undefined ? null : step === "drop" ? "drop" : { status: step, body: "<Error><Code>InternalError</Code></Error>" };
          },
        },
      },
      async (fake) => {
        const r = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl]);
        assert.equal(r.code, 0, r.stdout);
        assert.deepEqual([...r.sleeps].sort(), [1, 1, 1, 2, 2, 4].sort());
      },
    );
  });

  it("gives up after 3 retries with exit 7", async () => {
    await withFake({ hooks: { put: (_r, c) => (c.path === "css/a.css" ? { status: 500, body: "<Error><Code>InternalError</Code></Error>" } : null) } }, async (fake) => {
      const r = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 7);
      assert.equal(r.json.error.details.s3_code, "InternalError");
      assert.equal(putsFor(fake, "css/a.css").length, 4);
    });
  });

  it("re-uploads what /complete reports missing and completes again, at most 3 complete calls", async () => {
    let lost = 0;
    await withFake(
      {
        hooks: {
          // The first two complete calls see index.html missing, as if its PUT had not landed.
          complete: (_r, c) => {
            if (c.attempt > 2 || !c.artifact) return null;
            lost++;
            return { status: 409, body: { error: { code: "upload_incomplete", message: "1 file(s) missing", details: { missing: ["index.html"], missing_count: 1 } } } };
          },
        },
      },
      async (fake) => {
        const r = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl]);
        assert.equal(r.code, 0, r.stdout);
        assert.equal(lost, 2);
        assert.equal(apiRequests(fake, "/complete").length, 3);
        assert.equal(putsFor(fake, "index.html").length, 3); // uploaded three times (412 after the first)
      },
    );
    await withFake(
      { hooks: { complete: () => ({ status: 409, body: { error: { code: "upload_incomplete", message: "missing", details: { missing: ["index.html"], missing_count: 1 } } } }) } },
      async (fake) => {
        const r = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl]);
        assert.equal(r.code, 8);
        assert.equal(r.json.error.code, "upload_incomplete");
        assert.equal(apiRequests(fake, "/complete").length, 3);
      },
    );
  });

  it("maps publication failures to exit 8 and revoked keys to exit 4 with the reason", async () => {
    await withFake({ hooks: { complete: () => ({ status: 422, body: { error: { code: "upload_mismatch", message: "mismatch", details: { files: [{ path: "index.html", reason: "size" }] } } } }) } }, async (fake) => {
      const r = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 8);
      assert.equal(r.json.error.code, "upload_mismatch");
    });
    await withFake(
      { batchSize: 50, hooks: { uploads: () => ({ status: 403, body: { error: { code: "forbidden", message: "The artifact's API key was revoked.", details: { reason: "owner_key_revoked" } } } }) } },
      async (fake) => {
        const r = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl]);
        assert.equal(r.code, 4);
        assert.equal(r.json.error.details.reason, "owner_key_revoked");
        const human = await run(["publish", join(dir, "site"), "--api-url", fake.apiUrl]);
        assert.match(human.stderr, /revoked.*\(owner_key_revoked\)/);
      },
    );
    await withFake({ hooks: { complete: () => ({ status: 410, body: { error: { code: "gone", message: "The upload window has closed." } } }) } }, async (fake) => {
      assert.equal((await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl])).code, 8);
    });
  });

  it("retries idempotent API calls on 503 and on 429 after Retry-After, but never retries create", async () => {
    await withFake(
      {
        hooks: {
          complete: (_r, c) =>
            c.attempt === 1
              ? { status: 503, body: { error: { code: "service_misconfigured", message: "x" } } }
              : c.attempt === 2
                ? { status: 429, body: { error: { code: "rate_limited", message: "slow down" } }, headers: { "retry-after": "7" } }
                : null,
        },
      },
      async (fake) => {
        const r = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl]);
        assert.equal(r.code, 0, r.stdout);
        assert.deepEqual(r.sleeps, [1, 7]);
      },
    );
    await withFake({ hooks: { create: () => ({ status: 429, body: { error: { code: "quota_exceeded", message: "Daily quota reached.", details: { scope: "client" } } }, headers: { "retry-after": "3600" } }) } }, async (fake) => {
      const r = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 6);
      assert.equal(r.json.error.code, "quota_exceeded");
      assert.equal(r.json.error.details.retry_after_seconds, 3600);
      assert.equal(apiRequests(fake, "/v1/artifacts").length, 1);
      assert.deepEqual(r.sleeps, []);
    });
    await withFake({ hooks: { create: () => ({ status: 503, body: { error: { code: "service_misconfigured", message: "x" } } }) } }, async (fake) => {
      const r = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 7);
      assert.equal(apiRequests(fake, "/v1/artifacts").length, 1);
    });
  });

  it("refuses to send credentials to a complete URL on another origin, and upload URLs that are not https", async () => {
    await withFake({ advertisedOrigin: "http://127.0.0.2:9" }, async (fake) => {
      const r = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 7);
      assert.equal(r.json.error.code, "unsafe_url");
      assert.equal(apiRequests(fake, "/complete").length, 0);
    });
    await withFake({ uploadBase: "http://storage.example.com" }, async (fake) => {
      const r = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 7);
      assert.equal(r.json.error.code, "unsafe_url");
      assert.equal(puts(fake).length, 0);
    });
  });

  it("refuses private sites, an empty directory and a missing index.html locally", async () => {
    await withFake({}, async (fake) => {
      const { dir: d, cleanup: done } = await tempDir();
      try {
        await writeTree(d, { "empty/.env": "x", "noindex/page.html": "x" });
        for (const flags of [[], ["--dry-run"]]) {
          const args = ["publish", "--json", "--api-url", fake.apiUrl, ...flags];
          assert.equal((await run([...args, join(dir, "site"), "--access", "private"])).json.error.exit_code, 2);
          const empty = await run([...args, join(d, "empty")]);
          assert.deepEqual([empty.code, empty.json.error.code], [3, "empty_directory"]);
          const noIndex = await run([...args, join(d, "noindex")]);
          assert.deepEqual([noIndex.code, noIndex.json.error.code], [3, "missing_index"]);
          const file = await run([...args, join(dir, "notes.txt")]);
          assert.deepEqual([file.code, file.json.error.code], [3, "not_a_directory"]);
        }
        assert.equal(fake.requests.length, 0);
      } finally {
        await done();
      }
    });
  });
});

describe("delete", () => {
  it("deletes with the token from the flag or INSTAHOST_DELETE_TOKEN, or with the owner's API key", async () => {
    await withFake({ apiKeys: [API_KEY] }, async (fake) => {
      const shared = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl]);
      const viaEnv = await run(["delete", shared.json.id, "--json", "--api-url", fake.apiUrl], { env: { INSTAHOST_DELETE_TOKEN: shared.json.delete_token } });
      assert.equal(viaEnv.code, 0, viaEnv.stdout);
      assert.deepEqual(viaEnv.json, { ok: true, id: shared.json.id, status: "deleted", deleted_at: "2026-11-21T00:00:02Z" });
      const again = await run(["delete", shared.json.url, "--token", shared.json.delete_token, "--json", "--api-url", fake.apiUrl]);
      assert.equal(again.code, 0);

      const owned = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl, "--api-key", API_KEY]);
      const byKey = await run(["delete", owned.json.id, "--json", "--api-url", fake.apiUrl], { env: { INSTAHOST_API_KEY: API_KEY } });
      assert.equal(byKey.code, 0);
      assert.equal(apiRequests(fake, "/v1/artifacts/", "DELETE").at(-1)?.headers.authorization, `Bearer ${API_KEY}`);
    });
  });

  it("exit 9 for an unknown artifact, 4 for a wrong token, 2 without any credential", async () => {
    await withFake({}, async (fake) => {
      const shared = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl]);
      const unknown = await run(["delete", "aaaaaaaaaaaaaaaaaaaaaaaaaa", "--token", shared.json.delete_token, "--json", "--api-url", fake.apiUrl]);
      assert.deepEqual([unknown.code, unknown.json.error.code], [9, "not_found"]);
      const wrong = await run(["delete", shared.json.id, "--token", `ihd_${"Z".repeat(43)}`, "--json", "--api-url", fake.apiUrl]);
      assert.deepEqual([wrong.code, wrong.json.error.code], [4, "forbidden"]);
      const none = await run(["delete", shared.json.id, "--json", "--api-url", fake.apiUrl]);
      assert.equal(none.code, 2);
    });
  });

  it("retries a DELETE that hit a network error (it is idempotent)", async () => {
    await withFake({ hooks: { delete: (_r, c) => (c.attempt === 1 ? "drop" : null) } }, async (fake) => {
      const shared = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl]);
      const r = await run(["delete", shared.json.id, "--token", shared.json.delete_token, "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual(r.sleeps, [1]);
    });
  });
});

describe("--json purity and diagnostics", () => {
  it("prints exactly one JSON document and nothing on stderr for usage errors, network errors and API errors", async () => {
    const cases: [string[], number][] = [
      [["--json"], 0],
      [["--json", "--version"], 0],
      [["frobnicate", "--json"], 2],
      [["share", "--json", "--bogus"], 2],
      [["share", "a", "b", "--json"], 2],
      [["share", "x", "--json", "--api-url", "ftp://instahost.example"], 2], // not an https API URL
      [["publish", "x", "--ttl", "1w", "--json", "--api-url", "http://127.0.0.1:9"], 2],
      [["delete", "x", "--name", "y", "--json"], 2],
      [["delete", "x", "--dry-run", "--json"], 2],
      [["share", join(dir, "notes.txt"), "--dry-run", "--json"], 2],
      [["share", join(dir, "notes.txt"), "--include-dotfiles", "--json", "--api-url", "http://127.0.0.1:9"], 2], // option of another command
      [["publish", join(dir, "site"), "--concurrency", "17", "--json", "--api-url", "http://127.0.0.1:9"], 2],
      [["publish", join(dir, "site"), "--concurrency", "0", "--json", "--api-url", "http://127.0.0.1:9"], 2],
      [["share", join(dir, "notes.txt"), "--json", "--api-url", "http://127.0.0.1:1"], 7],
    ];
    for (const [argv, code] of cases) {
      const r = await run(argv);
      assert.equal(r.code, code, `${argv.join(" ")}: ${r.stdout}`);
      assert.equal(r.stderr, "", argv.join(" "));
      assert.equal(typeof r.json.ok, "boolean", argv.join(" "));
      if (!r.json.ok) assert.equal(r.json.error.exit_code, code);
    }
  });

  it("--verbose writes diagnostics to stderr with every token and signature masked", async () => {
    await withFake({ apiKeys: [API_KEY] }, async (fake) => {
      const r = await run(["share", join(dir, "notes.txt"), "--json", "--verbose", "--api-url", fake.apiUrl, "--api-key", API_KEY]);
      assert.equal(r.code, 0);
      assert.match(r.stderr, /api POST \/v1\/artifacts -> 201/);
      assert.match(r.stderr, /put notes\.txt -> 200/);
      assert.doesNotMatch(r.stderr, /ih[dak]_[A-Za-z0-9_-]{5}|X-Amz-Signature=deadbeef/);
      assert.equal(r.stdout.split("\n").filter(Boolean).length, 1);
    });
  });

  it("shows progress on stderr only when it is a TTY and not --json", async () => {
    await withFake({}, async (fake) => {
      const tty = await run(["publish", join(dir, "site"), "--api-url", fake.apiUrl], { tty: true });
      assert.match(tty.stderr, /uploading 120\/120\n/);
      const json = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl], { tty: true });
      assert.equal(json.stderr, "");
    });
  });
});
