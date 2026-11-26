# Changelog

Changes to `@instahost/cli` and its agent skill.

## 0.3.0

- Every CLI failure includes a suggested fix in JSON. API errors can link to the relevant documentation. The agent skill reads the fix and uses the artifact's delete token for cleanup after a failed publication.
- `share` and `publish` retry create with the same key to recover a lost response. If every create attempt times out, the CLI reports the failure after about two minutes. [Retrying a create](https://instahost.dev/docs/api/#retry-create)
- A rate-limited create can wait up to 60 seconds per retry, for up to three minutes of waiting across three retries. Use `--verbose` to see the waits. If the service still refuses the request, the fix points to `details.retry_after_seconds`.

## 0.2.0

- Added `publish --dry-run` to preview which files would be published or skipped, with byte counts and path warnings, without contacting InstaHost. Use `--json` to read the preview from a script or agent.
- The agent skill uses the dry run to review sites before publishing and links to `/v1/limits` instead of repeating service limits.
- CLI tags now get GitHub Releases with notes from this changelog after npm provenance is verified.

## 0.1.2

- Fixed the release workflow to publish the tested tarball by its local path. First npm release via trusted publishing with provenance.

## 0.1.1

- Tagged but not published to npm: the workflow treated the local tarball path as a GitHub repository. Use 0.1.2 instead.

## 0.1.0

- First npm release: `share`, `publish` and `delete`, with machine-readable JSON output and an agent skill in the repository.
