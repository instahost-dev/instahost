// The published package: manifest, version, export surface and the bin running the compiled CLI.
// Needs dist/ (pnpm test builds it first; CI builds it once and runs these tests on every Node).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import { VERSION } from "../src/config.ts";
import { PACKAGE_ROOT, REPO_ROOT } from "./helpers.ts";

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as Record<string, any>;
const bin = join(PACKAGE_ROOT, "bin/instahost.mjs");
/** An import specifier as a variable, so the type checker does not resolve the compiled package. */
const load = (specifier: string): Promise<Record<string, unknown>> => import(specifier);
const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of ["NODE_OPTIONS", "NODE_NO_WARNINGS", "NODE_PENDING_DEPRECATION", "NODE_REDIRECT_WARNINGS"]) delete env[k];
  return env;
};

describe("package manifest", () => {
  it("is a public, scoped, MIT package with no runtime dependencies", () => {
    assert.equal(manifest.name, "@instahost/cli");
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.license, "MIT");
    assert.equal(manifest.type, "module");
    assert.deepEqual(manifest.publishConfig, { access: "public" });
    assert.equal(manifest.repository.url, "git+https://github.com/instahost-dev/instahost.git");
    assert.equal(manifest.repository.directory, "packages/cli");
    assert.deepEqual(manifest.engines, { node: ">=20" });
    assert.deepEqual(manifest.bin, { instahost: "./bin/instahost.mjs" });
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"]) assert.equal(manifest[field], undefined, field);
  });
  it("ships only the bin, the compiled CLI, the vendored path rules, the Node check, README and LICENSE", () => {
    assert.deepEqual(manifest.files, ["bin", "dist", "src/vendor/paths.ts", "src/node-check.mjs", "README.md", "LICENSE"]);
    assert.deepEqual(manifest.exports, {
      ".": "./dist/index.js",
      "./paths": "./dist/vendor/paths.js",
      "./node-check": "./src/node-check.mjs",
      "./package.json": "./package.json",
    });
  });
  it("has the same version as the CLI's VERSION constant", () => {
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(VERSION, manifest.version);
  });
  it("carries the repository's LICENSE unchanged", () => {
    assert.equal(readFileSync(join(PACKAGE_ROOT, "LICENSE"), "utf8"), readFileSync(join(REPO_ROOT, "LICENSE"), "utf8"));
  });
});

describe("export surface (for InstaHost's own tests; not a supported SDK)", () => {
  it("exports exactly the documented names from the package root", async () => {
    const root = await load("@instahost/cli");
    assert.deepEqual(Object.keys(root).sort(), ["DEFAULT_API_URL", "EXIT", "HELP", "OPTIONS", "VERSION", "exitCodeForApiError", "main", "redact"]);
    assert.equal(root.VERSION, manifest.version);
    assert.equal(root.DEFAULT_API_URL, "https://instahost.dev");
    assert.equal(typeof root.main, "function");
    assert.equal((root.redact as (s: string) => string)(`ihd_${"x".repeat(43)}`), "ihd_***");
  });
  it("exports the compiled path rules, the Node check and the manifest", async () => {
    const paths = await load("@instahost/cli/paths");
    assert.deepEqual((paths.validatePath as (p: string) => unknown)("a/../b"), { ok: false, reason: "dot_segment" });
    const check = await load("@instahost/cli/node-check");
    assert.deepEqual(check.MIN_NODE, [20, 0]);
    // Read through require.resolve: import attributes for JSON differ between Node 20.0 and later.
    const resolved = createRequire(import.meta.url).resolve("@instahost/cli/package.json");
    assert.equal(resolved, join(PACKAGE_ROOT, "package.json"));
  });
  it("does not expose sources or tests", async () => {
    for (const specifier of ["@instahost/cli/dist/main.js", "@instahost/cli/src/main.ts", "@instahost/cli/test/helpers.ts"]) {
      await assert.rejects(load(specifier), (err: NodeJS.ErrnoException) => err.code === "ERR_PACKAGE_PATH_NOT_EXPORTED", specifier);
    }
  });
});

describe("the release workflow", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/release.yml"), "utf8");
  const releaseJob = workflow.slice(workflow.indexOf("\n  github-release:"));
  it("publishes the tested tarball by a ./ path, which npm cannot mistake for a GitHub owner/repo", () => {
    assert.match(workflow, /^\s+tarball="\.\/artifacts\/instahost-cli-\$VERSION\.tgz"$/m);
    const publishes = [...workflow.matchAll(/^\s+npm publish (\S+)/gm)].map((m) => m[1]);
    assert.deepEqual(publishes, ['"$tarball"']);
    assert.match(workflow, /npm publish "\$tarball" --access public --ignore-scripts --provenance$/m);
  });
  it("publishes only from the protected npm environment, with an OIDC token", () => {
    const job = workflow.slice(workflow.indexOf("\n  publish:"), workflow.indexOf("\n  github-release:"));
    assert.match(job, /^    environment: npm$/m);
    assert.match(job, /^      id-token: write$/m);
    assert.doesNotMatch(job, /^      contents: write$/m);
  });
  it("creates notes on an existing tag only after the verified npm publish", () => {
    assert.match(releaseJob, /^    needs: \[verify-tag, publish\]$/m);
    assert.match(releaseJob, /^      contents: write$/m);
    assert.doesNotMatch(releaseJob, /id-token: write/);
    assert.match(releaseJob, /gh release create "\$TAG" --verify-tag .*--notes-file /);
  });
  it("extracts only the matching changelog section and refuses missing notes", () => {
    const notes = join(PACKAGE_ROOT, "scripts/release-notes.mjs");
    const current = spawnSync(process.execPath, [notes, manifest.version], { encoding: "utf8" });
    const changelog = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const expected = changelog.split(`\n## ${manifest.version}\n`)[1]?.split("\n## ")[0]?.trim();
    assert.ok(expected);
    assert.deepEqual([current.status, current.stdout, current.stderr], [0, `${expected}\n`, ""]);
    const missing = spawnSync(process.execPath, [notes, "9999.9999.9999"], { encoding: "utf8" });
    assert.deepEqual([missing.status, missing.stdout], [1, ""]);
    assert.match(missing.stderr, /CHANGELOG\.md/);
  });
});

describe("the bin", () => {
  it("runs the compiled CLI with empty stderr", () => {
    assert.ok(existsSync(join(PACKAGE_ROOT, "dist/main.js")), "dist/main.js missing: build first");
    const plain = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8", env: cleanEnv() });
    assert.deepEqual([plain.status, plain.stdout, plain.stderr], [0, `${manifest.version}\n`, ""]);
    const json = spawnSync(process.execPath, [bin, "--version", "--json"], { encoding: "utf8", env: cleanEnv() });
    assert.deepEqual([json.status, json.stderr], [0, ""]);
    assert.deepEqual(JSON.parse(json.stdout), { ok: true, version: manifest.version });
  });
  it("prints one JSON document for a usage error", () => {
    const r = spawnSync(process.execPath, [bin, "share", "--json"], { encoding: "utf8", env: cleanEnv() });
    assert.equal(r.status, 2);
    assert.equal(r.stderr, "");
    assert.equal(JSON.parse(r.stdout).error.code, "usage");
  });
  it("is plain JavaScript that loads nothing before the Node check", () => {
    const text = readFileSync(bin, "utf8");
    assert.match(text, /^#!\/usr\/bin\/env node\n/);
    const imports = [...text.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ["../src/node-check.mjs"]);
    assert.ok(text.indexOf("nodeTooOld(") < text.indexOf('import(new URL("../dist/main.js"'));
  });
});
