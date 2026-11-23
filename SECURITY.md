# Security policy

## Reporting a vulnerability

Please report vulnerabilities in the CLI, the skill or the InstaHost service privately, through GitHub's [private vulnerability reporting](https://github.com/instahost-dev/instahost/security/advisories/new) for this repository. Do not open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it. Do not access other people's artifacts, degrade the service, or keep data you obtained while testing.

## Abuse

To report content hosted on InstaHost (`*.instahost.cloud` and `files.instahost.cloud`), use the abuse contact listed on [instahost.dev](https://instahost.dev).

## Supported versions

Only the latest published version of `@instahost/cli` receives fixes. Versions are published from this repository's `main` branch by its release workflow through npm trusted publishing, with a provenance attestation; check an installed copy with `npm audit signatures`. The first version, 0.1.0, is published by hand to create the package, so it has no attestation; later versions do.
