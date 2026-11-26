#!/usr/bin/env node
// Installs a packed tarball into an empty project with this Node's npm, then runs the installed
// bin the way users do: --version, then share, publish and delete against the in-process fake API
// and fake S3, with multi-megabyte files. Checks actionable errors and replay of a lost create.
// Also runs the tarball through npm exec (what npx -y does). Needs the compiled tests (build/test/).
//   node scripts/smoke-installed.mjs <instahost-cli-X.Y.Z.tgz>
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const tarball = process.argv[2] ? resolve(process.argv[2]) : "";
if (!tarball || !existsSync(tarball)) throw new Error("usage: node scripts/smoke-installed.mjs <tarball>");
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
/** @type {{ startFake: (options?: object) => Promise<{ apiUrl: string, objects: Map<string, Buffer>, artifacts: Map<string, unknown>, requests: unknown[], stop: () => Promise<void> }> }} */
const { startFake } = await import(new URL("../build/test/fake-server.js", import.meta.url).href);

const nodeBin = dirname(process.execPath);
const npm = existsSync(join(nodeBin, "npm")) ? join(nodeBin, "npm") : "npm";
const tmp = await mkdtemp(join(tmpdir(), "instahost-smoke-"));
const env = {
  PATH: [nodeBin, process.env.PATH ?? ""].join(delimiter),
  HOME: join(tmp, "home"),
  npm_config_cache: join(tmp, "npm-cache"),
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
};
const md5 = (/** @type {Buffer} */ b) => createHash("md5").update(b).digest("hex");
let failures = 0;

/**
 * Runs a command without blocking the event loop (the fake servers run in this process).
 * @param {string} cmd @param {string[]} args @param {{ cwd: string, env?: Record<string, string> }} options
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function exec(cmd, args, options) {
  return new Promise((done, fail) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: { ...env, ...options.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

/** @param {string} name @param {boolean} ok @param {string} [detail] */
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok    " : "FAILED"}  ${name}${ok || !detail ? "" : `\n        ${detail.replace(/\n/g, "\n        ")}`}`);
  if (!ok) failures++;
}

/** The one JSON document a --json run prints, or null. @param {string} stdout */
function single(stdout) {
  const lines = stdout.split("\n").filter(Boolean);
  if (lines.length !== 1) return null;
  try {
    return JSON.parse(/** @type {string} */ (lines[0]));
  } catch {
    return null;
  }
}

let loseNextCreate = false;
const fake = await startFake({ hooks: { create: () => {
  if (!loseNextCreate) return null;
  loseNextCreate = false;
  return "drop-after-create";
} } });
try {
  console.log(`node ${process.versions.node}, npm from ${npm}, ${tarball}`);
  const project = join(tmp, "project");
  await mkdir(project, { recursive: true });
  await mkdir(env.HOME, { recursive: true });
  await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "instahost-smoke", version: "0.0.0", private: true })}\n`);
  const install = await exec(npm, ["install", "--no-audit", "--no-fund", tarball], { cwd: project });
  check("npm install <tarball> into an empty project", install.code === 0, install.stderr);
  const installed = join(project, "node_modules/@instahost/cli");
  check("installed package has the expected version", existsSync(join(installed, "package.json")) && JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version === version);
  check("installed package has no sources or tests", !existsSync(join(installed, "src/main.ts")) && !existsSync(join(installed, "test")) && !existsSync(join(installed, "build")));
  const bin = join(project, "node_modules/.bin/instahost");

  const v = await exec(bin, ["--version"], { cwd: project });
  check("instahost --version", v.code === 0 && v.stdout === `${version}\n` && v.stderr === "", JSON.stringify(v));

  const report = randomBytes(6 * 1024 * 1024);
  await writeFile(join(project, "report.bin"), report);
  const share = await exec(bin, ["share", "report.bin", "--ttl", "1h", "--json", "--api-url", fake.apiUrl], { cwd: project });
  const shared = single(share.stdout);
  check("share a 6 MiB file (--json): exit 0, one document, empty stderr", share.code === 0 && share.stderr === "" && shared?.ok === true && shared.type === "file" && shared.total_bytes === report.length, JSON.stringify(share));
  check("the fake storage received the exact bytes", [...fake.objects.values()].some((b) => md5(b) === md5(report)));

  const site = join(project, "site");
  await mkdir(join(site, "assets"), { recursive: true });
  await writeFile(join(site, "index.html"), '<!doctype html><link rel="stylesheet" href="assets/a.css"><h1>smoke</h1>\n');
  await writeFile(join(site, "assets/a.css"), "h1{color:#123}\n");
  const blob = randomBytes(3 * 1024 * 1024 + 17);
  await writeFile(join(site, "assets/blob.bin"), blob);
  const beforePreview = fake.requests.length;
  const preview = await exec(bin, ["publish", "site", "--dry-run", "--json", "--api-url", fake.apiUrl], { cwd: project });
  const plan = single(preview.stdout);
  check("publish --dry-run: exit 0, one preview document, no requests", preview.code === 0 && preview.stderr === "" && plan?.ok === true && plan.dry_run === true && plan.file_count === 3 && fake.requests.length === beforePreview, JSON.stringify(preview));
  const publish = await exec(bin, ["publish", "site", "--ttl", "1h", "--json", "--api-url", fake.apiUrl], { cwd: project });
  const published = single(publish.stdout);
  check("publish a site with a 3 MiB asset (--json): exit 0, one document, empty stderr", publish.code === 0 && publish.stderr === "" && published?.ok === true && published.type === "site" && published.file_count === 3, JSON.stringify(publish));
  check("the fake storage received the site's asset", [...fake.objects.values()].some((b) => md5(b) === md5(blob)));

  const human = await exec(bin, ["share", "report.bin", "--api-url", fake.apiUrl], { cwd: project });
  check("share without --json: URL on stdout, empty stderr", human.code === 0 && /^URL {6}\S+/m.test(human.stdout) && human.stderr === "", JSON.stringify(human));

  const delShared = await exec(bin, ["delete", String(shared?.id), "--json", "--api-url", fake.apiUrl], { cwd: project, env: { INSTAHOST_DELETE_TOKEN: String(shared?.delete_token) } });
  check("delete with INSTAHOST_DELETE_TOKEN: exit 0, empty stderr", delShared.code === 0 && delShared.stderr === "" && single(delShared.stdout)?.status === "deleted", JSON.stringify(delShared));
  const delSite = await exec(bin, ["delete", String(published?.url), "--token", String(published?.delete_token), "--json", "--api-url", fake.apiUrl], { cwd: project });
  check("delete by URL with --token: exit 0, empty stderr", delSite.code === 0 && delSite.stderr === "" && single(delSite.stdout)?.status === "deleted", JSON.stringify(delSite));

  const usage = await exec(bin, ["publish", "site", "--name", "x", "--json"], { cwd: project });
  check("a usage error is one JSON document with exit 2", usage.code === 2 && usage.stderr === "" && single(usage.stdout)?.error?.code === "usage", JSON.stringify(usage));

  const refused = await exec(bin, ["share", "report.bin", "--ttl", "never", "--json", "--api-url", fake.apiUrl], { cwd: project });
  const error = single(refused.stdout)?.error;
  check("a refused create includes the API fix and docs", refused.code === 4 && refused.stderr === "" &&
    error?.fix === "Send an API key as `Authorization: Bearer ihk_…`, or drop `persistent` and set `ttl_seconds`." &&
    error.docs === `${fake.apiUrl}/docs/api/#error-persistent_requires_api_key`, JSON.stringify(refused));

  await writeFile(join(project, "replay.txt"), "create replay\n");
  const beforeReplay = fake.artifacts.size;
  loseNextCreate = true;
  const replay = await exec(bin, ["share", "replay.txt", "--json", "--verbose", "--api-url", fake.apiUrl], { cwd: project });
  check("a lost create answer replays and publishes one artifact", replay.code === 0 && single(replay.stdout)?.ok === true &&
    replay.stderr.includes("(replayed)") && fake.artifacts.size === beforeReplay + 1 &&
    [...fake.objects.values()].some((b) => b.toString("utf8") === "create replay\n"), JSON.stringify(replay));

  const npxDir = join(tmp, "npx");
  await mkdir(npxDir);
  const npx = await exec(npm, ["exec", "--yes", `--package=${tarball}`, "--", "instahost", "--version"], { cwd: npxDir });
  check("npm exec --yes --package=<tarball> -- instahost --version (the npx -y path)", npx.code === 0 && npx.stdout.trim().split("\n").at(-1) === version, JSON.stringify(npx));
} finally {
  await fake.stop();
  await rm(tmp, { recursive: true, force: true });
}
if (failures) {
  console.error(`smoke-installed: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("smoke-installed: all checks passed");
