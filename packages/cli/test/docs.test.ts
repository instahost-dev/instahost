// The README files and the agent skill: every command they show uses real commands and flags, the
// documented result fields and exit codes match the CLI, the unscoped-package warning is present,
// and the quick start runs as written (against the in-process fake API).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXIT } from "../src/errors.ts";
import { GLOBAL, HELP, OPTIONS, PER_COMMAND, UNDOCUMENTED_OPTIONS } from "../src/main.ts";
import { parseTtl } from "../src/ttl.ts";
import { startFake } from "./fake-server.ts";
import { PACKAGE_ROOT, REPO_ROOT, run, tempDir, writeTree } from "./helpers.ts";

const DOCS = ["README.md", "packages/cli/README.md", "skills/instahost/SKILL.md"] as const;
const read = (doc: string) => readFileSync(join(REPO_ROOT, doc), "utf8");
const CLI = "npx -y @instahost/cli";

interface Block {
  lang: string;
  body: string;
}
function blocks(md: string): Block[] {
  return [...md.matchAll(/^```([a-z]*)\n([\s\S]*?)^```$/gm)].map((m) => ({ lang: m[1] ?? "", body: m[2] ?? "" }));
}
/** The first fenced block after a heading. */
function blockAfter(md: string, heading: string): Block {
  const at = md.indexOf(`\n${heading}\n`);
  assert.ok(at >= 0, `heading ${heading} missing`);
  const block = blocks(md.slice(at))[0];
  assert.ok(block, `no code block after ${heading}`);
  return block;
}

/**
 * CLI invocations in code blocks, as [command, flags with values]. A call is found anywhere in a
 * line (after `&&`, `;`, `|` or `$(` too); env assignments before it are skipped. Every token that
 * starts with "-" is a flag.
 */
function invocations(md: string): { line: string; command: string | undefined; flags: [string, string | undefined][] }[] {
  const out = [];
  for (const block of blocks(md)) {
    if (block.lang === "json") continue;
    for (const raw of block.body.split("\n")) {
      for (const segment of raw.split(/&&|\|\||;|\$\(|(?<!\[[^\]]*)\|/)) {
        const line = segment.trim().replace(/^\$ /, "").replace(/^(?:[A-Z_]+=\S+ )+/, "");
        const rest = line.startsWith(`${CLI} `) ? line.slice(CLI.length + 1) : line.startsWith("instahost ") ? line.slice("instahost ".length) : null;
        if (rest === null) {
          if (line === "npm i -g @instahost/cli") continue;
          assert.doesNotMatch(line, /@instahost\/cli|(?:^|\s)instahost\s+(?:share|publish|delete)\b/, `a CLI call not in the documented form: ${raw}`);
          continue;
        }
        // Placeholders such as <id or URL> are one argument; [brackets] mark optional flags.
        const tokens = rest.replace(/<[^>]*>/g, "<arg>").replace(/[[\]]/g, " ").split(/\s+/).filter(Boolean);
        const flags: [string, string | undefined][] = [];
        let command: string | undefined;
        for (let i = 0; i < tokens.length; i++) {
          const t = tokens[i] as string;
          if (t === "-h") flags.push(["help", undefined]);
          else if (t.startsWith("--")) {
            const [name, inline] = t.slice(2).split("=", 2) as [string, string | undefined];
            const takesValue = Object.hasOwn(OPTIONS, name) && OPTIONS[name as keyof typeof OPTIONS].type === "string";
            const next = tokens[i + 1];
            flags.push([name, inline ?? (takesValue && next !== undefined && !next.startsWith("-") ? (i++, next) : undefined)]);
          } else if (t.startsWith("-")) flags.push([`unknown short flag ${t}`, undefined]);
          else if (command === undefined) command = t;
        }
        out.push({ line, command, flags });
      }
    }
  }
  return out;
}

const ACCESS: Record<string, string[]> = { share: ["unlisted", "public", "private"], publish: ["unlisted", "public"] };

describe("commands in the README files and the skill", () => {
  for (const doc of DOCS) {
    it(`${doc} uses only real commands and flags`, () => {
      const found = invocations(read(doc));
      assert.ok(found.length >= 3, `${doc}: expected CLI examples`);
      for (const { line, command, flags } of found) {
        const names = flags.map(([n]) => n);
        if (command === undefined) {
          assert.ok(names.every((n) => n === "help" || n === "version" || n === "json"), line);
          continue;
        }
        assert.ok(Object.hasOwn(PER_COMMAND, command), `${doc}: unknown command in: ${line}`);
        const allowed = new Set([...GLOBAL, ...(PER_COMMAND[command] ?? [])]);
        for (const [name, value] of flags) {
          assert.ok(Object.hasOwn(OPTIONS, name), `${doc}: unknown flag --${name} in: ${line}`);
          assert.ok(allowed.has(name), `${doc}: --${name} does not apply to ${command} in: ${line}`);
          if (OPTIONS[name as keyof typeof OPTIONS].type === "string") assert.ok(value !== undefined, `${doc}: --${name} needs a value in: ${line}`);
          if (name === "ttl" && value && value !== "<arg>") assert.doesNotThrow(() => parseTtl(value), line);
          if (name === "access" && value && value !== "<arg>") {
            for (const mode of value.split("|")) assert.ok((ACCESS[command] ?? []).includes(mode), `${doc}: --access ${mode} for ${command} in: ${line}`);
          }
        }
      }
    });

    it(`${doc} mentions no flag the CLI does not have`, () => {
      for (const m of read(doc).matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)) assert.ok(Object.hasOwn(OPTIONS, m[1] as string), `${doc}: --${m[1]}`);
    });

    it(`${doc} runs the CLI only as ${CLI} and warns about the unscoped package`, () => {
      const text = read(doc);
      for (const block of blocks(text)) {
        for (const line of block.body.split("\n")) {
          const npx = /\bnpx\s+(.*)$/.exec(line);
          if (npx) assert.ok(npx[1]?.startsWith("-y @instahost/cli ") || npx[1] === "skills add instahost-dev/instahost", `${doc}: ${line}`);
        }
      }
      assert.doesNotMatch(text, /\bnpx\s+(?:-y\s+|--yes\s+)?instahost\b/);
      assert.doesNotMatch(text, /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add)\s+(?:-g\s+|--global\s+|-D\s+)?instahost\b/);
      assert.match(text, /npm package named `instahost` \(without the `@instahost\/` scope\) is unrelated/);
    });
  }
});

describe("the CLI reference (packages/cli/README.md)", () => {
  const readme = () => read("packages/cli/README.md");
  it("lists every option once, with the commands it applies to", () => {
    const text = readme();
    const table = text.slice(text.indexOf("\n## Options\n"), text.indexOf("\n## ", text.indexOf("\n## Options\n") + 1));
    const rows = [...table.matchAll(/^\| (`--[^|]+) \| ([^|]+) \|/gm)].map((m) => ({ names: [...(m[1] ?? "").matchAll(/`--([a-z-]+)/g)].map((n) => n[1] as string), commands: (m[2] ?? "").trim() }));
    assert.deepEqual(rows.flatMap((r) => r.names).sort(), Object.keys(OPTIONS).filter((o) => !UNDOCUMENTED_OPTIONS.includes(o)).sort());
    for (const { names, commands } of rows) {
      for (const name of names) {
        const expected = GLOBAL.includes(name) ? "all" : Object.keys(PER_COMMAND).filter((c) => PER_COMMAND[c]?.includes(name)).join(", ");
        assert.equal(commands, expected, `--${name}`);
      }
    }
  });
  it("shows the synopsis of every command", () => {
    const synopsis = blockAfter(readme(), "## Commands").body.split("\n").filter(Boolean);
    const commands = synopsis.map((l) => /^instahost (\S+)/.exec(l)?.[1]);
    assert.deepEqual(commands, Object.keys(PER_COMMAND));
    for (const line of synopsis) {
      const command = /^instahost (\S+)/.exec(line)?.[1] as string;
      const flags = [...line.matchAll(/--([a-z-]+)/g)].map((m) => m[1]);
      assert.deepEqual(flags, PER_COMMAND[command], line);
    }
  });
});

describe("team-only options", () => {
  // InstaHost cannot be self-hosted: pointing the CLI at another API is for the InstaHost team only.
  const texts: [string, string][] = [...DOCS.map((doc) => [doc, read(doc)] as [string, string]), ["--help", HELP]];
  for (const [name, text] of texts) {
    it(`${name} never mentions --api-url or INSTAHOST_API_URL`, () => {
      for (const option of UNDOCUMENTED_OPTIONS) assert.ok(!text.includes(`--${option}`), `${name}: --${option}`);
      assert.doesNotMatch(text, /INSTAHOST_API_URL|API URL|api_url|self-host/i);
    });
  }
  it("still accepts them", async () => {
    const r = await run(["share", "/nonexistent/file.txt", "--json", "--api-url", "https://api.example"]);
    assert.equal(r.json.error.code, "file_not_found");
  });
});

describe("documented results", () => {
  it("list exactly the fields of a real share result", async () => {
    const fake = await startFake();
    const { dir, cleanup } = await tempDir();
    try {
      await writeTree(dir, { "a.txt": "hello" });
      const r = await run(["share", join(dir, "a.txt"), "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 0, r.stdout);
      const real = Object.keys(r.json).sort();
      const skill = read("skills/instahost/SKILL.md");
      const table = skill.slice(skill.indexOf("## Read the result"), skill.indexOf("Failure:"));
      const skillFields = [...table.matchAll(/^\| (.+?) \|/gm)].flatMap((m) => [...(m[1] ?? "").matchAll(/`([a-z_]+)`/g)].map((f) => f[1] as string));
      assert.deepEqual([...new Set(skillFields)].sort(), real, "skill result table");
      const readme = blockAfter(read("packages/cli/README.md"), "## Output");
      assert.equal(readme.lang, "json");
      assert.deepEqual(Object.keys(JSON.parse(readme.body)).sort(), real, "packages/cli/README.md output example");
    } finally {
      await cleanup();
      await fake.stop();
    }
  });

  it("show exactly the fields of a real publish preview", async () => {
    const fake = await startFake();
    const { dir, cleanup } = await tempDir();
    try {
      await writeTree(dir, { "index.html": "hello", ".env": "x" });
      const r = await run(["publish", dir, "--dry-run", "--json", "--api-url", fake.apiUrl]);
      assert.equal(r.code, 0, r.stdout);
      const readme = read("packages/cli/README.md");
      const at = readme.indexOf("\n## Preview a publish\n");
      assert.ok(at >= 0, "heading ## Preview a publish missing");
      const example = blocks(readme.slice(at, readme.indexOf("\n## ", at + 1))).find((b) => b.lang === "json");
      assert.ok(example, "no JSON example under ## Preview a publish");
      const shown = JSON.parse(example.body) as Record<string, any>;
      const keys = (o: object) => Object.keys(o).sort();
      assert.deepEqual(keys(shown), keys(r.json), "packages/cli/README.md preview example");
      for (const list of ["files", "skipped"]) assert.deepEqual(keys(shown[list][0]), keys(r.json[list][0]), `preview example: ${list}`);
      assert.equal(fake.requests.length, 0);
    } finally {
      await cleanup();
      await fake.stop();
    }
  });

  for (const doc of ["packages/cli/README.md", "skills/instahost/SKILL.md"]) {
    it(`${doc} documents every exit code`, () => {
      const text = read(doc);
      const table = text.slice(text.indexOf("## Exit codes"));
      const codes = [...table.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]));
      assert.deepEqual(codes, [...new Set(Object.values(EXIT))].sort((a, b) => a - b));
    });
  }
});

describe("the quick start", () => {
  it("is the same block in both README files", () => {
    assert.equal(blockAfter(read("README.md"), "## Quick start").body, blockAfter(read("packages/cli/README.md"), "## Quick start").body);
  });

  it("runs as written: two JSON documents with URLs, nothing on stderr", async () => {
    const block = blockAfter(read("README.md"), "## Quick start");
    assert.equal(block.lang, "sh");
    assert.equal(block.body.split(CLI).length - 1, 2);
    const script = block.body.replaceAll(CLI, `"$INSTAHOST_TEST_NODE" "$INSTAHOST_TEST_BIN"`);
    const fake = await startFake();
    const { dir, cleanup } = await tempDir();
    try {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir, INSTAHOST_API_URL: fake.apiUrl, INSTAHOST_TEST_NODE: process.execPath, INSTAHOST_TEST_BIN: join(PACKAGE_ROOT, "bin/instahost.mjs") };
      // --norc and no stdin: Debian and Ubuntu builds of bash read /etc/bash.bashrc when stdin is a
      // socket (as Node's piped stdin is), and that file breaks under -u.
      const child = spawn("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d));
      child.stderr.on("data", (d: Buffer) => (stderr += d));
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      assert.equal(stderr, "");
      assert.equal(code, 0, stdout);
      const docs = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { ok: boolean; type: string; url: string; delete_token: string });
      assert.deepEqual(docs.map((d) => [d.ok, d.type]), [[true, "file"], [true, "site"]]);
      for (const d of docs) assert.match(d.delete_token, /^ihd_/);
      // The same block as instahost.dev/docs/cli/: the shared file and the site's index.html hold one line.
      assert.deepEqual([...fake.objects.values()].map((b) => b.toString("utf8")), ["Hello from InstaHost\n", "Hello from InstaHost\n"]);
    } finally {
      await cleanup();
      await fake.stop();
    }
  });
});
