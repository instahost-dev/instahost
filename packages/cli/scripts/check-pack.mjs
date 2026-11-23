#!/usr/bin/env node
// Checks a packed tarball (pnpm pack) before it is tested or published: exactly the files the
// package should ship, and a manifest with no workspace or catalog protocols left in it.
//   node scripts/check-pack.mjs <instahost-cli-X.Y.Z.tgz>
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const tarball = process.argv[2];
if (!tarball) throw new Error("usage: node scripts/check-pack.mjs <tarball>");
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

/** Every .js file under dir, as "a/b.js" (walked by hand: readdir's recursive option needs Node 20.1). @param {URL} dir @param {string} [prefix] @returns {string[]} */
const listJs = (dir, prefix = "") =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listJs(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`) : entry.name.endsWith(".js") ? [`${prefix}${entry.name}`] : [],
  );
const expected = new Set([
  "package/package.json",
  "package/README.md",
  "package/LICENSE",
  "package/bin/instahost.mjs",
  "package/src/node-check.mjs",
  "package/src/vendor/paths.ts",
  ...listJs(new URL("dist/", root)).map((p) => `package/dist/${p}`),
]);
const entries = execFileSync("tar", ["-tzf", resolve(tarball)], { encoding: "utf8" }).split("\n").filter((e) => e && !e.endsWith("/"));
const problems = [];
for (const e of entries) if (!expected.has(e)) problems.push(`unexpected file in the tarball: ${e}`);
for (const e of expected) if (!entries.includes(e)) problems.push(`missing from the tarball: ${e}`);

const packed = JSON.parse(execFileSync("tar", ["-xzOf", resolve(tarball), "package/package.json"], { encoding: "utf8" }));
if (packed.name !== manifest.name || packed.version !== manifest.version) problems.push(`packed ${packed.name}@${packed.version}, expected ${manifest.name}@${manifest.version}`);
if (/"(?:workspace|catalog):/.test(JSON.stringify(packed))) problems.push("the packed manifest still has a workspace: or catalog: specifier");
if (packed.private !== undefined) problems.push("the packed manifest has a private field");
for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) if (packed[field] !== undefined) problems.push(`the packed manifest has ${field}`);
const vendored = execFileSync("tar", ["-xzOf", resolve(tarball), "package/src/vendor/paths.ts"], { encoding: "utf8" });
if (vendored !== readFileSync(new URL("src/vendor/paths.ts", root), "utf8")) problems.push("package/src/vendor/paths.ts differs from src/vendor/paths.ts");

if (problems.length) {
  for (const p of problems) console.error(`check-pack: ${p}`);
  process.exit(1);
}
console.log(`check-pack: ${entries.length} files, ${packed.name}@${packed.version}, as expected`);
