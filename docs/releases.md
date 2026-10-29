# Releases

GitHub is the canonical source, CI system, and release host for Grounds. No GitLab runner or mirrored repository is needed. CLI and TUI versions must match.

## Release gates

The project owner has authorized public distribution under the [MIT license](../LICENSE). Release packaging must preserve that license and the vendored component notices described in [third-party notices](../THIRD_PARTY_NOTICES.md). Validate third-party redistribution requirements before publishing bundled assets.

Changes go through GitHub pull requests and the repository's build and test workflows. To release, update the CLI, TUI, plugin manifests, and lockfiles to the same version, merge to `main`, then push a matching `vX.Y.Z` tag. The release workflow checks that the tag points to the exact checked-out commit on `origin/main`, repeats CI, and validates versions and license metadata before packaging. Release automation must run validation against the exact tagged commit, build both packages from lockfiles, and attach package tarballs and checksums to a GitHub Release. A failed check must prevent release publication. Never use CI logs or release assets to distribute secrets or private evaluation data.

## Release tag protection

Release tags `v*` have a separate protection policy from `grounds/candidates/*` and `grounds/deliveries/*`. Only repository administrators may create release tags, and existing release tags must not be moved or deleted. Configure separate rulesets so that the administrator exception for tag creation does not bypass update or deletion restrictions. Inspect the effective GitHub rules before cutting a release; archive namespace readiness does not establish release tag protection.

Version `0.2.50` is the first release candidate for this GitHub distribution process. Its version number does not establish production maturity, stable API guarantees, or completion of the operating-system test matrix. Publish only after the checks for its exact tag pass, and describe unresolved limitations in the release notes.

The earlier `v0.2.49` tag is retained for traceability. Its release validation found a verification pagination ordering defect, so no release packages were published for that tag. Version `0.2.50` fixes ordering across fractional timestamp precisions and legacy UTC formats, with regression coverage for page boundaries.

Upgrading to `0.2.50` invalidates version 1 opaque list cursors, including candidate, verification, and issue activity lists. Their old timestamp keys may have lost precision and cannot be safely resumed. A saved version 1 cursor returns `VALIDATION_ERROR`; restart from the first page without `--cursor`, then follow the newly returned cursors. This changes pagination state only, not stored timestamps or artifact digests.

## Install a GitHub release

After a release is approved and available, download both package tarballs and the checksums from the same [GitHub Release](https://github.com/MaybeLL/grounds-open/releases). Verify the checksums before installation. Assets are named `maybell-grounds-X.Y.Z.tgz`, `maybell-grounds-tui-X.Y.Z.tgz`, and `SHA256SUMS`. Install the downloaded matching CLI and TUI tarballs using `npm install -g /path/to/cli.tgz /path/to/tui.tgz --registry=https://registry.npmjs.org`, substituting their actual paths. This does not require publication on npm. Native modules may need local build tools.

Do not install assets from an untrusted fork. Retain the release commit and checksums when reporting a problem. Local databases and workspace state require their own backup and migration procedures; upgrading the executable alone does not authorize a database migration.
