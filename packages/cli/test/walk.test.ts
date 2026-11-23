// The directory walk: exclusions, symlinks, special files, NFC collisions and root-absolute references.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CliError } from "../src/errors.ts";
import { findRootAbsoluteReferences, hashFile, walkSite } from "../src/walk.ts";
import { fileTempDir, md5, tempDir, writeTree } from "./helpers.ts";

const NFD_E = "é"; // é decomposed
const root = await fileTempDir();
await writeTree(root, {
  "index.html": "<p>hi</p>",
  "css/site.css": "p{}",
  "js/app.js": "1",
  "assets/data/nested/data.json": "{}",
  ".well-known/security.txt": "Contact: x",
  ".hidden": "h",
  ".env": "SECRET=1",
  ".env.local": "SECRET=2",
  "deploy/server.pem": "-----BEGIN",
  "id_rsa": "key",
  ".git/HEAD": "ref",
  ".git/objects/aa/bbbb": "blob",
  "sub/.ssh/config": "Host x",
  ".DS_Store": "x",
  "._index.html": "x",
  "__MACOSX/index.html": "x",
  "Thumbs.db": "x",
  [`caf${NFD_E}.txt`]: "nfd",
  ".config/x.txt": "dot dir",
});
await symlink(join(root, "index.html"), join(root, "link.html"));
await symlink(join(root, "css"), join(root, "linked-dir"));
spawnSync("mkfifo", [join(root, "pipe")]);

describe("walkSite", () => {
  it("keeps regular files with NFC paths, sorted, hashed, and reports what it skipped and why", async () => {
    const r = await walkSite(root, { includeDotfiles: false });
    assert.deepEqual(
      r.files.map((f) => f.path),
      [".well-known/security.txt", "assets/data/nested/data.json", `café.txt`, "css/site.css", "index.html", "js/app.js"],
    );
    const index = r.files.find((f) => f.path === "index.html");
    assert.equal(index?.md5, md5("<p>hi</p>"));
    assert.equal(index?.size, 9);
    assert.equal(r.totalBytes, r.files.reduce((n, f) => n + f.size, 0));
    // The on-disk name is still used to read the NFD file.
    assert.match(r.files.find((f) => f.path === "café.txt")?.absPath ?? "", new RegExp(`${NFD_E}\\.txt$`));
    const skipped = Object.fromEntries(r.skipped.map((s) => [s.path, s.reason]));
    assert.deepEqual(skipped, {
      ".DS_Store": "os_metadata",
      "._index.html": "os_metadata",
      ".config/": "dotfile",
      ".env": "sensitive",
      ".env.local": "sensitive",
      ".git/": "sensitive",
      ".hidden": "dotfile",
      "Thumbs.db": "os_metadata",
      "__MACOSX/": "os_metadata",
      "deploy/server.pem": "sensitive",
      "id_rsa": "sensitive",
      "link.html": "symlink",
      "linked-dir": "symlink",
      "pipe": "special",
      "sub/.ssh/": "sensitive",
    });
  });

  it("--include-dotfiles adds dotfiles but never credentials, VCS data or OS metadata", async () => {
    const r = await walkSite(root, { includeDotfiles: true });
    const paths = r.files.map((f) => f.path);
    assert.ok(paths.includes(".hidden") && paths.includes(".config/x.txt"));
    for (const p of [".env", ".env.local", ".git/HEAD", "id_rsa", ".DS_Store", "sub/.ssh/config"]) assert.ok(!paths.includes(p), p);
  });

  it("stops on a name the server would refuse, listing it (exit 3)", async () => {
    const { dir, cleanup: done } = await tempDir();
    try {
      await writeTree(dir, { "index.html": "x", "bad\u0001name.txt": "x", "trailing‮.txt": "x" });
      await assert.rejects(walkSite(dir, { includeDotfiles: false }), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "invalid_path");
        assert.equal(err.exitCode, 3);
        assert.equal((err.details?.paths as unknown[]).length, 2);
        return true;
      });
    } finally {
      await done();
    }
  });

  it("stops when two names collide after NFC normalisation", async () => {
    const { dir, cleanup: done } = await tempDir();
    try {
      await writeTree(dir, { "index.html": "x", "café.txt": "nfc", [`caf${NFD_E}.txt`]: "nfd" });
      await assert.rejects(walkSite(dir, { includeDotfiles: false }), (err: unknown) => err instanceof CliError && err.code === "duplicate_path" && err.exitCode === 3);
    } finally {
      await done();
    }
  });

  it("never follows a symlink, even one swapped in after listing (O_NOFOLLOW)", async () => {
    const { dir, cleanup: done } = await tempDir();
    try {
      await writeFile(join(dir, "real.txt"), "x");
      await symlink(join(dir, "real.txt"), join(dir, "link.txt"));
      await assert.rejects(hashFile(join(dir, "link.txt"), "link.txt"), (err: unknown) => err instanceof CliError && err.code === "symlink_refused");
    } finally {
      await done();
    }
  });
});

describe("root-absolute references", () => {
  it("flags root-absolute src/href/url() and <base href=\"/\">, not relative or protocol-relative URLs", async () => {
    const { dir, cleanup: done } = await tempDir();
    try {
      const files = {
        "index.html": '<script src="./app.js"></script><img src="img/a.png"><a href="https://x/">x</a><script src="//cdn.example/x.js"></script>',
        "abs.html": '<link href="/style.css" rel="stylesheet">',
        "base.html": '<base href="/"><p>x</p>',
        "unquoted.html": "<img src=/logo.png>",
        "a.css": "body{background:url(/bg.png)}",
        "b.css": "@import '/other.css';",
        "ok.css": "body{background:url(bg.png)} p{background:url('//cdn/x.png')}",
        "app.js": 'fetch("/api")',
      };
      await writeTree(dir, files);
      const local = Object.entries(files).map(([path, c]) => ({ path, absPath: join(dir, path), size: Buffer.byteLength(c), md5: md5(c) }));
      const found = await findRootAbsoluteReferences(local);
      assert.deepEqual(found.map((f) => f.path).sort(), ["a.css", "abs.html", "b.css", "base.html", "unquoted.html"]);
      assert.equal(found.find((f) => f.path === "base.html")?.base, true);
    } finally {
      await done();
    }
  });
});

describe("walk limits", () => {
  it("refuses an empty tree only at the command level (walk returns no files)", async () => {
    const { dir, cleanup: done } = await tempDir();
    try {
      await mkdir(join(dir, "empty"));
      const r = await walkSite(dir, { includeDotfiles: false });
      assert.deepEqual(r.files, []);
    } finally {
      await done();
    }
  });
});
