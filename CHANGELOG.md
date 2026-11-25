# Changelog

Changes to `@instahost/cli` and its agent skill.

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
