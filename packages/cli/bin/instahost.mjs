#!/usr/bin/env node
// InstaHost CLI entry point. Plain JavaScript on purpose: the Node version is checked before the
// compiled CLI (dist/) is imported, so an old Node gets one clear answer instead of a syntax error.
// The npm package named "instahost" (unscoped) is unrelated to this project; this is @instahost/cli.
import { nodeTooOld, tooOldDocument } from "../src/node-check.mjs";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
if (nodeTooOld(process.versions.node)) {
  const doc = tooOldDocument(process.versions.node);
  if (json) process.stdout.write(`${JSON.stringify(doc)}\n`);
  else process.stderr.write(`instahost: ${doc.error.message}\n`);
  process.exit(2);
}
let main;
try {
  ({ main } = await import(new URL("../dist/main.js", import.meta.url).href));
} catch (err) {
  // A damaged or partial install (dist/ missing or unreadable): still exactly one answer.
  const code = (err && typeof err === "object" && "code" in err && typeof err.code === "string") ? err.code : "unknown";
  const message = `The CLI could not load its compiled files (${code}); reinstall it: npx -y @instahost/cli@latest, or npm i -g @instahost/cli.`;
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "cli_load_failed", message, details: { reason: code }, exit_code: 1 } })}\n`);
  else process.stderr.write(`instahost: ${message}\n`);
  process.exit(1);
}
process.exitCode = await main(argv);
