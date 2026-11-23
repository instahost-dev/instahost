// Removes a build output directory inside this package (dist or build) before a fresh compile, so
// files deleted from src/ or test/ cannot linger in the output.
import { rm } from "node:fs/promises";

const allowed = new Set(["dist", "build"]);
for (const name of process.argv.slice(2)) {
  if (!allowed.has(name)) throw new Error(`clean.mjs: refusing to remove ${JSON.stringify(name)}`);
  await rm(new URL(`../${name}/`, import.meta.url), { recursive: true, force: true });
}
