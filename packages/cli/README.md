# @instahost/cli

Instant hosting and sharing for AI agents. `share` a file or `publish` a built static site and get back an HTTPS URL with an access mode and a lifetime. No account and no login are needed for links that last up to 7 days. The service runs at [instahost.dev](https://instahost.dev).

> The npm package named `instahost` (without the `@instahost/` scope) is unrelated to this project. Do not install it. Use `@instahost/cli`.

Requires Node.js 20 or later. The package has no runtime dependencies.

## Quick start

```sh
echo 'Hello from InstaHost' > hello.txt
mkdir -p hello-site && echo 'Hello from InstaHost' > hello-site/index.html
npx -y @instahost/cli share hello.txt --ttl 1h --json
npx -y @instahost/cli publish hello-site --ttl 1h --json
```

Or install it once:

```sh
npm i -g @instahost/cli
instahost publish ./dist --json
```

## Commands

```text
instahost share <file>    [--ttl 24h] [--access unlisted|public|private] [--name <filename>] [--content-type <type>]
instahost publish <dir>   [--ttl 24h] [--access unlisted|public] [--include-dotfiles] [--concurrency 6] [--dry-run]
instahost delete <id|url> [--token <ihd_...>]
```

```sh
npx -y @instahost/cli share ./report.pdf --json
npx -y @instahost/cli share ./data.json --access private --ttl 1h --json
npx -y @instahost/cli publish ./dist --ttl 7d --json
npx -y @instahost/cli delete <id or URL> --token <delete_token> --json
```

A site is a directory with `index.html` at its root. Its pages must use relative URLs (for Vite, set `base: "./"`).

## Options

| Option | Commands | Meaning |
|---|---|---|
| `--json` | all | Print exactly one JSON document on stdout for every outcome, and nothing on stderr unless `--verbose`. |
| `--api-key <key>` | all | An API key (`ihk_...`); else `INSTAHOST_API_KEY`. Longer lifetimes, `--ttl never` and higher limits. Keys are issued by the operator. |
| `--verbose` | all | Diagnostics on stderr, with tokens and URL signatures masked. |
| `--help`, `-h` | all | Usage. With `--json`: `{"ok": true, "help": "..."}`. |
| `--version` | all | The CLI version. With `--json`: `{"ok": true, "version": "..."}`. |
| `--ttl <lifetime>` | share, publish | A number with `s`, `m`, `h` or `d` (`30m`, `24h`, `7d`), plain seconds, or `never` (persistent; needs an API key). Default 24 hours; anonymous maximum 7 days. |
| `--access <mode>` | share, publish | `unlisted` (default), `public`, or `private` (share only). |
| `--name <filename>` | share | The name to share the file under (no `/`); the default is the file's own name. |
| `--content-type <type>` | share | Declare the media type instead of deriving it from the extension. |
| `--include-dotfiles` | publish | Also publish dot-prefixed files and directories. Credentials, VCS data and OS metadata stay excluded. |
| `--concurrency <n>` | publish | Parallel uploads, 1 to 16 (default 6). |
| `--dry-run` | publish | Show which files would be published and which skipped, without contacting InstaHost. |
| `--token <ihd_...>` | delete | The artifact's delete token. |

An option given to a command it does not belong to is a usage error. `delete` takes an artifact id or any of its URLs. Its credential is the first of `--token`, `--api-key`, `INSTAHOST_DELETE_TOKEN` and `INSTAHOST_API_KEY`; the environment keeps the token out of the process list.

## Access and lifetimes

| Access | Who can open it |
|---|---|
| `unlisted` (default) | Anyone with the URL. Sent with `X-Robots-Tag: noindex, nofollow`. |
| `public` | Anyone with the URL; it may be indexed. |
| `private` | Files only: only with the access token, through `access_url`. |

`expires_at` is fixed at create and counted from creation. Expiry and deletion take effect on the next request. Current limits are at [instahost.dev/v1/limits](https://instahost.dev/v1/limits).

## What share and publish refuse or skip

- `share` refuses symbolic links, directories, names that look like credentials, and any file whose real path goes through a credential or VCS directory (`.ssh`, `.git`, `.aws`, ...).
- `publish` refuses a directory inside such a directory, and one without a root `index.html`. It never follows symbolic links, and it skips credential and VCS names, OS metadata (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `._*`, `__MACOSX/`) and dot-prefixed paths except `.well-known` (unless `--include-dotfiles`). Each skipped path is listed under `skipped` with its reason.
- Both refuse a file that changes between hashing and upload.

Detection is by name only: the CLI does not read file contents to find secrets. Publish a build output directory (`dist/`, `build/`, `out/`), never a repository root or home directory.

## Preview a publish

```sh
npx -y @instahost/cli publish ./dist --dry-run --json
```

The preview runs every local check that `publish` runs: the options, the API key's format and the file checks, including `--include-dotfiles` if set. It then stops without contacting InstaHost, so it cannot create an artifact or confirm server-side limits, quotas or that the API key is accepted. Without `--json`, it prints included paths and sizes to stdout, and skips and warnings to stderr. With `--json`, it prints one document:

```json
{"ok": true, "dry_run": true, "type": "site", "files": [{"path": "index.html", "size": 42}],
 "file_count": 1, "total_bytes": 42, "skipped": [{"path": ".env", "reason": "sensitive"}], "warnings": []}
```

Paths are relative to the site root and sizes are in bytes. Warnings can flag root-absolute URLs that may break if the published site is served under a path. Local failures use the usual error document and exit code.

## Output

Without `--json`, the result goes to stdout (URL, access URL, expiry and the delete command, `npx -y @instahost/cli delete <id> --token ...`), and skipped files, warnings and errors go to stderr. With `--json`, `share` and `publish` print:

```json
{"ok": true, "id": "...", "type": "site", "access": "unlisted", "url": "https://<id>.instahost.cloud/",
 "expires_at": "2026-11-29T10:00:00Z", "delete_token": "ihd_...", "access_token": null, "access_url": null,
 "file_count": 12, "total_bytes": 482113,
 "skipped": [{"path": ".git/", "reason": "sensitive"}],
 "warnings": []}
```

`access_token` and `access_url` are set for private files. `delete` prints `{"ok": true, "id": "...", "status": "deleted", "deleted_at": "..."}`. Every failure prints one document:

```json
{"ok": false, "error": {"code": "persistent_requires_api_key", "message": "Persistent artifacts need an API key.",
 "fix": "Remove `--ttl never` to use the default lifetime, or keep it and pass an API key with `--api-key` or `INSTAHOST_API_KEY`.",
 "docs": "https://instahost.dev/docs/api/#error-persistent_requires_api_key", "exit_code": 4}}
```

`error.fix` says what to do next. When the CLI recognises the API's advice, it rewrites it in CLI terms. It names the CLI's own options and environment variables and states values such as the longest `--ttl` or a quota reset time. For a request the API could not read, it says to try the latest CLI. Most other API advice is passed through as the API wrote it and can name HTTP fields. Values it refers to, such as paths, appear in `error.details` when available. API errors can also include an `error.docs` link to the relevant entry. Human output shows the fix and docs link when available. [API error reference](https://instahost.dev/docs/api/#errors)

When a failure happens after the artifact was created, `error.details.artifact` holds `{id, url, delete_token, access_url}`. Use the delete token to remove the artifact.

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | Success. |
| 1 | Internal error in the CLI (`internal_error`, `cli_load_failed`). |
| 2 | Usage: unknown command or option, bad value, missing credential, unsupported Node.js version. |
| 3 | Local input refused: missing file, not a file or directory, symbolic link, credential-like name, invalid or duplicate path, no `index.html`, empty directory, or over 10,000 files, all before any request; or a file that changed or became unreadable during the upload, after create (with `error.details.artifact`). |
| 4 | Authentication or authorization: HTTP 401 or 403. |
| 5 | Rejected by the server: 400, 413, 415, 422 and other 4xx not listed here. |
| 6 | Rate limited or over quota: HTTP 429. `error.details.retry_after_seconds` carries `Retry-After`. |
| 7 | Network or server failure: 5xx, connection errors, storage refusing an upload after retries, a malformed answer, or an unsafe URL from the server. |
| 8 | Publication failed during the uploads or `complete`: 409, 410 or 422. |
| 9 | Not found: HTTP 404. |

## Retries and safety

- Each upload is retried up to 3 times (after 1, 2 and 4 s) on network errors, 429 and 5xx. A URL close to expiry is refreshed before use, and a 403 gets a fresh URL once per file.
- API calls retry up to 3 times on network errors, 502, 503 and 504, and on 429 `rate_limited` after `Retry-After` (up to 60 s).
- `share` and `publish` send the same key and body on every attempt to create an artifact. A retry within the replay window can recover the original response. Create also retries on 500 and can retry a quota refusal after a network error or 5xx. When every request times out, a create can take about two minutes to report failure. [Retrying a create](https://instahost.dev/docs/api/#retry-create)
- Credentials are sent only to the API origin. Upload URLs must be `https`, and the API's own follow-up URLs must be on its origin. Redirects are refused.

## Programmatic use

The package's JavaScript exports exist for InstaHost's own tests. They are not a supported SDK and may change in any release. Run the `instahost` bin instead.

## License

MIT. Source: [github.com/instahost-dev/instahost](https://github.com/instahost-dev/instahost).
