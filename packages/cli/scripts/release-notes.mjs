import { readFileSync } from "node:fs";

const version = process.argv[2];
const changelog = readFileSync(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");
const matching = changelog.split(/^## /m).slice(1).filter((section) => section.split("\n", 1)[0]?.trimEnd() === version);
const notes = matching.length === 1 ? matching[0]?.split("\n").slice(1).join("\n").trim() : "";

if (!notes) {
  console.error(`Expected one nonempty section headed "## ${version}" in CHANGELOG.md.`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${notes}\n`);
}
