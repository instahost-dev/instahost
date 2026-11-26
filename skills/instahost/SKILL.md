---
name: instahost
description: Share a local file or publish a built static site and get an HTTPS link, with no account or login, using the InstaHost CLI (npx -y @instahost/cli). Use when the user asks for a shareable link to a file (report, screenshot, PDF, JSON, media) or to a website directory with an index.html, or asks to take such a link down.
---

# InstaHost

InstaHost turns a local file or a built static site into an HTTPS URL. No account or login is needed for temporary links. The CLI needs Node.js 20 or later and runs with `npx`.

The npm package named `instahost` (without the `@instahost/` scope) is unrelated to this project. Always run `@instahost/cli`.

## When to use

- The user wants a link to a file they have or you produced: a report, screenshot, PDF, JSON, audio or video.
- The user wants a built static site online: a directory with `index.html` at its root.
- The user wants to remove a link you created earlier.

Do not use it for secrets or private data unless the user explicitly asks for that file to be shared (see Cautions).

## Share a file

```sh
npx -y @instahost/cli share report.pdf --json
```

## Publish a site

The directory must have `index.html` at its root. Assets must use relative URLs (for Vite, set `base: "./"`).

Publish only a build output directory such as `dist/`, `build/` or `out/`: never a repository root or a home directory. Preview it first:

```sh
npx -y @instahost/cli publish ./dist --dry-run --json
```

Check that every path in `files` is meant to be reachable by anyone who has the link, and review `skipped` and `warnings`. The preview is local: it makes no InstaHost API requests and cannot confirm server limits. Use the same directory and options for the real publish. If the preview fails, fix the problem before publishing. The one exception is a CLI older than 0.2.0, which rejects `--dry-run` as an unknown option: then list the directory instead (for example `find ./dist -type f`) and check every file the same way.

```sh
npx -y @instahost/cli publish ./dist --json
```

## Read the result

Always pass `--json`: the CLI then prints exactly one JSON document on stdout, whatever happens. Parse it instead of reading the human output. npm may add its own notices on stderr; they are not errors. If stdout is not one JSON document, the CLI did not run (npx could not fetch or start it, for example offline): report the npm error from stderr instead.

Success (share and publish):

| Field | Meaning |
|---|---|
| `ok` | `true` |
| `id` | The artifact id (26 characters). |
| `type` | `file` or `site`. |
| `access` | `unlisted`, `public` or `private`. |
| `url` | The link to give the user. |
| `expires_at` | When the link stops working (ISO 8601), or `null` for a persistent artifact. |
| `delete_token` | `ihd_...`, shown once. The only way to delete the artifact without an API key. Keep it, and do not post it anywhere public. |
| `access_token`, `access_url` | Set for private files only; `access_url` opens the file. Otherwise `null`. |
| `file_count`, `total_bytes` | What was uploaded. |
| `skipped` | Files `publish` left out, as `{path, reason}`. |
| `warnings` | Problems worth telling the user about, as `{code, message, paths}`. |

Failure: `{"ok": false, "error": {"code": "...", "message": "...", "fix": "...", "docs": "...", "exit_code": 4}}`.

### Handle a failure

Follow `error.fix` and look up any values it names in `error.details`. When `error.details.artifact` is present, delete that artifact with its `delete_token`. If the fix calls for waiting more than about a minute or obtaining a credential, tell the user what `error.fix` says. Use `error.message` on CLI versions older than 0.3.0, which lack `error.fix`. An API error can include an `error.docs` link.

## Lifetimes and access

- `--ttl` takes a number with `s`, `m`, `h` or `d` (for example `30m` or `2h`), or plain seconds. `--ttl never` needs an API key.
- `--access unlisted` (the default): anyone with the URL can open it; search engines are asked not to index it.
- `--access public`: anyone with the URL can open it, and search engines may index it.
- `--access private` (share only): the file opens only through `access_url`. Sites cannot be private.

Pick the shortest lifetime that fits the task, for example:

```sh
npx -y @instahost/cli share chart.png --ttl 1h --json
npx -y @instahost/cli share data.json --access private --ttl 30m --json
```

## Delete

```sh
npx -y @instahost/cli delete <id or URL> --token <delete_token> --json
```

The token can also come from the environment, which keeps it out of the process list:

```sh
INSTAHOST_DELETE_TOKEN=<delete_token> npx -y @instahost/cli delete <id or URL> --json
```

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | Success. |
| 1 | Internal error in the CLI. |
| 2 | Usage error or unsupported Node.js version. |
| 3 | Local input refused. |
| 4 | Authentication or authorization (HTTP 401 or 403). |
| 5 | Request rejected by the server. |
| 6 | Rate limited or over quota (HTTP 429). |
| 7 | Network or server failure. |
| 8 | Publication failed after create. |
| 9 | Not found (HTTP 404). |

## Cautions

- Anyone who has an unlisted or public URL can open it. Treat every link as public.
- Never upload credentials, keys, `.env` files or other private data unless the user explicitly asked for that file to be shared. The CLI refuses common credential names and skips dotfiles when publishing, but it checks names only, not contents.
- Give the user the `url` (or `access_url` for a private file) and the expiry. Give the delete token or delete command only in a private reply to the user, never in a pull request, issue, commit, chat channel or anything else others can read; when posting a link publicly, post only the `url` and the expiry.
- Check https://instahost.dev/v1/limits for current lifetimes, file and site size limits, file counts and quotas.
- An API key (`INSTAHOST_API_KEY`, `ihk_...`) allows longer lifetimes and higher limits. Use one only if the user provides it.

Docs: https://instahost.dev/docs/
