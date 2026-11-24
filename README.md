# InstaHost

Instant hosting and sharing for AI agents. Give it a file or a built static site and get back an HTTPS URL with an access mode and a lifetime. There is no account and no login for links that last up to 7 days.

This repository holds the InstaHost command line, published on npm as [`@instahost/cli`](https://www.npmjs.com/package/@instahost/cli), and an agent skill that teaches coding agents to use it. The service runs at [instahost.dev](https://instahost.dev); its documentation is at [instahost.dev/docs](https://instahost.dev/docs/).

> The npm package named `instahost` (without the `@instahost/` scope) is unrelated to this project. Do not install it. Use `@instahost/cli`.

## Quick start

Requires Node.js 20 or later.

```sh
echo 'Hello from InstaHost' > hello.txt
mkdir -p hello-site && echo 'Hello from InstaHost' > hello-site/index.html
npx -y @instahost/cli share hello.txt --ttl 1h --json
npx -y @instahost/cli publish hello-site --ttl 1h --json
```

Each command prints one JSON document. Open its `url`. Keep its `delete_token` to remove the artifact before it expires:

```sh
npx -y @instahost/cli delete <id> --token <delete_token> --json
```

To install the CLI once instead of running it through `npx`:

```sh
npm i -g @instahost/cli
instahost share report.pdf --json
```

The [CLI reference](packages/cli/README.md) covers every command, option, output field and exit code.

## For agents

Install the skill into a project with the [skills](https://www.npmjs.com/package/skills) installer, which supports Claude Code, Codex, Cursor and many other agents. The installer itself needs Node.js 22.20 or later:

```sh
npx skills add instahost-dev/instahost
```

It asks which agents to install to. Without a terminal, for example when an agent runs it, name the agent instead: `npx skills add instahost-dev/instahost -a claude-code -y` (or `-a cursor`, `-a codex`, `-a '*'` for all).

The skill is [`skills/instahost/SKILL.md`](skills/instahost/SKILL.md); on older Node.js, copy it into your agent's skills directory. Agents without skills can use the commands above directly, or read [instahost.dev/llms.txt](https://instahost.dev/llms.txt). Without Node.js, the [HTTP quick start](https://instahost.dev/docs/#quickstart-http) needs only bash, curl and jq.

## What gets shared

- **Unlisted** (the default): anyone with the URL can open it. Search engines are asked not to index it.
- **Public**: anyone with the URL can open it, and it may be indexed.
- **Private** (files only): only the returned `access_url` opens it.

Links expire after 24 hours by default and after at most 7 days without an API key. Never share credentials or private data: the CLI refuses common credential file names and skips dotfiles when publishing, but it checks names, not contents. Publish a build output directory, never a repository root or home directory. Current limits are at [instahost.dev/v1/limits](https://instahost.dev/v1/limits).

## Repository layout

- `packages/cli/`: the CLI. TypeScript compiled with `tsc`, with no runtime dependencies.
- `packages/cli/src/vendor/paths.ts`: the path and sensitive-file rules, a verbatim copy of the rules the InstaHost API enforces. Changes to it start in the service, not here.
- `skills/instahost/`: the agent skill.

## Development

You need Node.js 22.18 or later, for running the tests from the TypeScript sources, and pnpm 11 (for example `npm i -g pnpm@11.20.0`).

```sh
pnpm install
pnpm check
```

`pnpm check` typechecks against the Node.js 20 type definitions (which rules out APIs newer than Node 20, though not those added in later 20.x releases), builds `dist/`, and runs the tests from the TypeScript sources. CI also compiles the tests and runs them, together with the packed package, on exactly Node.js 20.0.0, on 22 and 24, and on the latest release.

## Releases

A release is an annotated tag `cli-vX.Y.Z` on `main` that matches `packages/cli/package.json` and the CLI's `VERSION`. The release workflow repeats the CI checks and publishes the tested tarball to npm through trusted publishing, with a provenance attestation, from the protected `npm` environment. The one-time owner setup is described at the top of [`release.yml`](.github/workflows/release.yml).

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

[MIT](LICENSE)
