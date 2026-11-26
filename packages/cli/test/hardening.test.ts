// Regression tests for hardening findings:
// URL refresh across lifetimes, body-read failures, a lost /complete answer, files changed or
// swapped after hashing, sensitive publish roots, terminal-safe output, the CLI loader, malformed
// API answers, signed content-length, credential precedence and command dispatch.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ApiClient } from "../src/api-client.ts";
import { createArtifact, uploadAndComplete } from "../src/upload.ts";
import { type Fake, type FakeOptions, startFake } from "./fake-server.ts";
import { PACKAGE_ROOT, fileTempDir, md5, run, tempDir, writeTree } from "./helpers.ts";

const API_KEY = `ihk_abcdefghijkl_${"K".repeat(43)}`;
const dir = await fileTempDir();
await writeTree(dir, { "notes.txt": "hello", "site/index.html": "<p>x</p>", "site/a.css": "p{}" });

async function withFake<T>(options: FakeOptions, fn: (fake: Fake) => Promise<T>): Promise<T> {
  const fake = await startFake(options);
  try {
    return await fn(fake);
  } finally {
    await fake.stop();
  }
}
const count = (fake: Fake, server: "api" | "s3", part = "") => fake.requests.filter((r) => r.server === server && r.path.includes(part)).length;

describe("upload URLs across several lifetimes", () => {
  async function slowFiles(n: number) {
    const files = [];
    for (let i = 0; i < n; i++) {
      const path = join(dir, `slow${i}.txt`);
      const body = `file ${i}`;
      await writeFile(path, body);
      files.push({ path: `f${String(i).padStart(2, "0")}.txt`, absPath: path, size: Buffer.byteLength(body), md5: md5(body) });
    }
    return files;
  }
  async function createVia(fake: Fake, files: { path: string; size: number; md5: string }[]) {
    const client = new ApiClient({ apiUrl: fake.apiUrl, sleep: async () => {} });
    const created = await createArtifact(client, { type: "site", files: files.map(({ path, size, md5: m }) => ({ path, size, md5: m })) }, null);
    return { client, created };
  }

  it("replaces a URL about to expire before using it, instead of sending a PUT that gets 403", async () => {
    await withFake({ urlTtlSeconds: 2, putDelayMs: 300 }, async (fake) => {
      const files = await slowFiles(8); // about 2.4 s: the create batch's URLs expire midway
      const { client, created } = await createVia(fake, files);
      const artifact = await uploadAndComplete({ client, created, files, concurrency: 1, minUrlLifeMs: 500 });
      assert.equal(artifact.status, "published");
      assert.equal(count(fake, "s3"), 8, "every PUT used a live URL (no 403 and retry)");
      assert.equal(count(fake, "api", "/uploads"), 1);
    });
  });

  it("re-issues on 403 again when a later wave of URLs dies in the same batch (each file may re-issue once)", async () => {
    // Twice during the batch, every URL issued so far stops working (as if it had expired).
    let invalidBefore = 0;
    const waves = [2, 6];
    const put: FakeOptions["hooks"] = {
      put: (req) => {
        const stored = fakeRef.objects.size;
        if (waves[0] !== undefined && stored >= waves[0]) {
          waves.shift();
          invalidBefore = Date.now();
        }
        const exp = Number(new URL(req.path, "http://x").searchParams.get("exp"));
        return exp - 300_000 < invalidBefore ? { status: 403, body: "<Error><Code>AccessDenied</Code></Error>" } : null;
      },
    };
    let fakeRef!: Fake;
    await withFake({ hooks: put }, async (fake) => {
      fakeRef = fake;
      const files = await slowFiles(10);
      const { client, created } = await createVia(fake, files);
      const artifact = await uploadAndComplete({ client, created, files, concurrency: 1 });
      assert.equal(artifact.status, "published");
      assert.equal(fake.objects.size, 10);
      assert.ok(count(fake, "api", "/uploads") >= 2);
    });
  });
});

describe("API answers cut short", () => {
  it("retries an idempotent call whose response body is cut, and reports a network error (exit 7) if it keeps failing", async () => {
    await withFake({ hooks: { delete: (_r, c) => (c.attempt === 1 ? "cut" : null) } }, async (fake) => {
      const shared = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl]);
      const r = await run(["delete", shared.json.id, "--token", shared.json.delete_token, "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 0, r.stdout);
      assert.deepEqual(r.sleeps, [1]);
    });
    await withFake({ hooks: { delete: () => "cut" } }, async (fake) => {
      const shared = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl]);
      const r = await run(["delete", shared.json.id, "--token", shared.json.delete_token, "--json", "--api-url", fake.apiUrl]);
      assert.deepEqual([r.code, r.json.error.code], [7, "network_error"]);
      assert.deepEqual(r.sleeps, [1, 2, 4]);
    });
  });
});

describe("failures after create keep the artifact deletable", () => {
  it("a lost /complete answer still reports the id, URL and delete token, in JSON and in human mode", async () => {
    // The server publishes, but every answer to /complete is lost.
    await withFake({ hooks: { complete: (_r, c) => (c.artifact && (c.artifact.status = "published"), "drop") } }, async (fake) => {
      const r = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 7);
      const a = r.json.error.details.artifact;
      const id = [...fake.artifacts.keys()][0];
      assert.equal(a.id, id);
      assert.equal(a.delete_token, fake.artifacts.get(id as string)?.deleteToken);
      assert.match(a.url, /notes\.txt$/);
      const fix = "Check the network connection, then run the command again.";
      assert.equal(r.json.error.fix, fix + " The artifact in `details.artifact` may exist: delete it with its `delete_token`.");
      const human = await run(["share", join(dir, "notes.txt"), "--api-url", fake.apiUrl]);
      assert.ok(human.stderr.includes(`  fix:  ${fix}\n`));
      assert.doesNotMatch(human.stderr, /details\.artifact/);
      assert.match(human.stderr, /the artifact may exist .*; delete it with: npx -y @instahost\/cli delete [a-z2-7]{26} --token ihd_/);
    });
  });
});

describe("files changed after hashing", () => {
  it("a same-size change is file_changed (exit 3), not a network failure", async () => {
    const { dir: d, cleanup: done } = await tempDir();
    try {
      await writeFile(join(d, "c.txt"), "AAAA");
      await withFake({ hooks: { create: () => (spawnSync("sh", ["-c", `printf BBBB > '${join(d, "c.txt")}'`]), null) } }, async (fake) => {
        const r = await run(["share", join(d, "c.txt"), "--json", "--api-url", fake.apiUrl]);
        assert.deepEqual([r.code, r.json.error.code], [3, "file_changed"]);
        assert.equal(r.json.error.details.artifact.id.length, 26);
      });
    } finally {
      await done();
    }
  });

  it("a symlink swapped in after hashing is refused before any byte is read (no PUT)", async () => {
    const { dir: d, cleanup: done } = await tempDir();
    try {
      await writeTree(d, { "site/index.html": "<p>x</p>", "site/pic.txt": "SAFE!!!", "secret": "SECRET!" });
      const swap = () => {
        spawnSync("sh", ["-c", `rm '${join(d, "site/pic.txt")}' && ln -s '${join(d, "secret")}' '${join(d, "site/pic.txt")}'`]);
        return null;
      };
      await withFake({ hooks: { create: swap } }, async (fake) => {
        const r = await run(["publish", join(d, "site"), "--json", "--api-url", fake.apiUrl, "--concurrency", "1"]);
        assert.deepEqual([r.code, r.json.error.code], [3, "file_changed"]);
        assert.ok(!fake.requests.some((q) => q.server === "s3" && q.body.toString() === "SECRET!"));
      });
    } finally {
      await done();
    }
  });
});

describe("a different file at the same path after hashing", () => {
  it("is refused by device and inode before any byte is sent, even at the same size", async () => {
    const { dir: d, cleanup: done } = await tempDir();
    try {
      await writeTree(d, { "site/index.html": "<p>x</p>", "site/pic.txt": "SAFE!!!", "other": "SECRET!" });
      const swap = () => {
        spawnSync("mv", [join(d, "other"), join(d, "site/pic.txt")]);
        return null;
      };
      await withFake({ hooks: { create: swap } }, async (fake) => {
        const r = await run(["publish", join(d, "site"), "--json", "--api-url", fake.apiUrl, "--concurrency", "1"]);
        assert.deepEqual([r.code, r.json.error.code], [3, "file_changed"]);
        assert.ok(!fake.requests.some((q) => q.server === "s3" && q.body.toString() === "SECRET!"));
      });
    } finally {
      await done();
    }
  });
});

describe("sensitive publish roots", () => {
  it("refuses a directory inside .ssh or .git, also through a symlink, before any request", async () => {
    const { dir: d, cleanup: done } = await tempDir();
    try {
      await writeTree(d, { ".ssh/index.html": "x", ".ssh/known_hosts": "x", "proj/.git/index.html": "x" });
      await symlink(join(d, ".ssh"), join(d, "innocent-site"));
      await withFake({}, async (fake) => {
        for (const target of [join(d, ".ssh"), join(d, "innocent-site"), join(d, "proj/.git")]) {
          const r = await run(["publish", target, "--json", "--api-url", fake.apiUrl]);
          assert.deepEqual([r.code, r.json.error.code], [3, "sensitive_file"], target);
        }
        assert.equal(fake.requests.length, 0);
      });
    } finally {
      await done();
    }
  });
});

describe("terminal-safe human output", () => {
  it("prints control characters in file names as escapes", async () => {
    const { dir: d, cleanup: done } = await tempDir();
    try {
      await writeTree(d, { "index.html": "x", ".\u001b]52;c;cHduZWQ=\u0007x": "x" });
      await withFake({}, async (fake) => {
        const r = await run(["publish", d, "--api-url", fake.apiUrl]);
        assert.equal(r.code, 0);
        assert.doesNotMatch(r.stderr, /\u001b|\u0007/);
        assert.match(r.stderr, /skipped {2}\.\\u001b\]52;c;cHduZWQ=\\u0007x/);
      });
    } finally {
      await done();
    }
  });
});

describe("answers that would otherwise become internal errors", () => {
  it("a path with a quote after token= still gives its own error document", async () => {
    const r = await run(["share", join(dir, 'x&token=a".png'), "--json", "--api-url", "http://127.0.0.1:9"]);
    assert.deepEqual([r.code, r.json.error.code], [3, "file_not_found"]);
  });

  it("malformed 2xx answers are bad_response (exit 7), and batch_size 0 cannot loop", async () => {
    await withFake({ hooks: { create: () => ({ status: 201, body: {} }) } }, async (fake) => {
      const r = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl]);
      assert.deepEqual([r.code, r.json.error.code], [7, "bad_response"]);
    });
    const zeroBatch = {
      artifact: { id: "a".repeat(26), type: "site", access: "unlisted", status: "pending", url: "http://sites.localhost:9/x/" },
      delete_token: `ihd_${"D".repeat(43)}`,
      upload: { expires_at: "2099-01-01T00:00:00Z", files: [], batch_size: 0, remaining: 2, uploads_url: "/v1/artifacts/x/uploads", complete_url: "/v1/artifacts/x/complete" },
    };
    await withFake({ hooks: { create: () => ({ status: 201, body: zeroBatch }) } }, async (fake) => {
      const r = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl]);
      assert.deepEqual([r.code, r.json.error.code], [7, "bad_response"]);
    });
  });

  it("refuses command names inherited from Object.prototype", async () => {
    for (const cmd of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      const r = await run([cmd, "aaaaaaaaaaaaaaaaaaaaaaaaaa", "--json", "--api-url", "http://127.0.0.1:9"], { env: { INSTAHOST_DELETE_TOKEN: `ihd_${"A".repeat(43)}` } });
      assert.deepEqual([r.code, r.json.error.code], [2, "usage"], cmd);
      // With a command-specific flag the lookup itself must not misbehave (no TypeError, exit 1).
      const flagged = await run([cmd, "aaaaaaaaaaaaaaaaaaaaaaaaaa", "--token", `ihd_${"A".repeat(43)}`, "--json", "--api-url", "http://127.0.0.1:9"]);
      assert.deepEqual([flagged.code, flagged.json.error.code], [2, "usage"], `${cmd} --token`);
    }
  });

  it("share of a directory points to publish", async () => {
    const r = await run(["share", join(dir, "site"), "--json", "--api-url", "http://127.0.0.1:9"]);
    assert.deepEqual([r.code, r.json.error.code], [3, "not_a_file"]);
    assert.match(r.json.error.message, /use instahost publish/);
  });

  it("an invalid Retry-After falls back to the backoff instead of retrying at once", async () => {
    await withFake({ hooks: { complete: (_r, c) => (c.attempt === 1 ? { status: 429, body: { error: { code: "rate_limited", message: "slow" } }, headers: { "retry-after": "-5" } } : null) } }, async (fake) => {
      const r = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 0);
      assert.deepEqual(r.sleeps, [1]);
    });
  });
});

describe("delete credentials, flags before the environment", () => {
  it("an explicit --api-key wins over a stale INSTAHOST_DELETE_TOKEN; --token wins over both", async () => {
    await withFake({ apiKeys: [API_KEY] }, async (fake) => {
      const owned = await run(["share", join(dir, "notes.txt"), "--json", "--api-url", fake.apiUrl, "--api-key", API_KEY]);
      const stale = `ihd_${"S".repeat(43)}`;
      const r = await run(["delete", owned.json.id, "--api-key", API_KEY, "--json", "--api-url", fake.apiUrl], { env: { INSTAHOST_DELETE_TOKEN: stale } });
      assert.equal(r.code, 0, r.stdout);
      const del = fake.requests.filter((q) => q.method === "DELETE").at(-1);
      assert.equal(del?.headers.authorization, `Bearer ${API_KEY}`);
      const byToken = await run(["delete", owned.json.id, "--token", owned.json.delete_token, "--api-key", API_KEY, "--json", "--api-url", fake.apiUrl]);
      assert.equal(byToken.code, 0);
      assert.equal(fake.requests.filter((q) => q.method === "DELETE").at(-1)?.headers.authorization, `Bearer ${owned.json.delete_token}`);
    });
  });
});

describe("signed content-length", () => {
  it("is checked against the file and sent by fetch itself; a mismatch is file_changed", async () => {
    await withFake({ signContentLength: true }, async (fake) => {
      const r = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 0, r.stdout);
      for (const put of fake.requests.filter((q) => q.server === "s3")) assert.equal(Number(put.headers["content-length"]), put.body.length);
    });
    await withFake(
      {
        signContentLength: true,
        hooks: {
          create: () => {
            // The file grows after hashing: the signed length no longer matches.
            spawnSync("sh", ["-c", `printf ' more' >> '${join(dir, "site/a.css")}'`]);
            return null;
          },
        },
      },
      async (fake) => {
        const r = await run(["publish", join(dir, "site"), "--json", "--api-url", fake.apiUrl]);
        assert.deepEqual([r.code, r.json.error.code], [3, "file_changed"]);
        await writeFile(join(dir, "site/a.css"), "p{}");
      },
    );
  });
});

describe("the bin when the compiled CLI cannot be loaded (a damaged install)", () => {
  async function brokenInstall(): Promise<{ bin: string; done: () => Promise<void> }> {
    const { dir: d, cleanup: done } = await tempDir();
    await mkdir(join(d, "bin"));
    await mkdir(join(d, "src"));
    await copyFile(join(PACKAGE_ROOT, "bin/instahost.mjs"), join(d, "bin/instahost.mjs"));
    await copyFile(join(PACKAGE_ROOT, "src/node-check.mjs"), join(d, "src/node-check.mjs"));
    await copyFile(join(PACKAGE_ROOT, "package.json"), join(d, "package.json"));
    return { bin: join(d, "bin/instahost.mjs"), done };
  }
  it("prints one JSON document, exit 1, and says to reinstall", async () => {
    const { bin, done } = await brokenInstall();
    try {
      const r = spawnSync(process.execPath, [bin, "--version", "--json"], { encoding: "utf8" });
      assert.equal(r.status, 1);
      assert.equal(r.stderr, "");
      const lines = r.stdout.split("\n").filter(Boolean);
      assert.equal(lines.length, 1, r.stdout);
      const doc = JSON.parse(lines[0] as string);
      assert.equal(doc.ok, false);
      assert.equal(doc.error.code, "cli_load_failed");
      assert.equal(doc.error.exit_code, 1);
      assert.equal(doc.error.details.reason, "ERR_MODULE_NOT_FOUND");
      assert.match(doc.error.message, /reinstall/);
      assert.match(doc.error.fix, /^Reinstall the CLI .*\.$/);
      assert.doesNotMatch(doc.error.fix, /ih[dak]_\S+|--api-url|Idempotency-Key/);
      assert.equal(doc.error.docs, undefined);
    } finally {
      await done();
    }
  });
  it("prints one line on stderr and nothing on stdout without --json", async () => {
    const { bin, done } = await brokenInstall();
    try {
      const r = spawnSync(process.execPath, [bin, "share", "x.png"], { encoding: "utf8" });
      assert.equal(r.status, 1);
      assert.equal(r.stdout, "");
      assert.match(r.stderr, /^instahost: The CLI could not load its compiled files \(ERR_MODULE_NOT_FOUND\); reinstall it: .+\n$/);
    } finally {
      await done();
    }
  });
});
