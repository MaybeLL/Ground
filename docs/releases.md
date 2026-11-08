# Releases

GitHub is the canonical source, CI system, and release host for Grounds. No GitLab runner or mirrored repository is needed. Current source releases contain the CLI and bundled plugin; their versions must match. The legacy TUI package has been retired under D149. No new TUI package is built or published, and a new work-model TUI is not implemented. Already published packages and tags are unchanged.

Public npm packages `@maybell/grounds` and `@maybell/grounds-tui` are available beginning with version `0.2.52`. Version `0.2.53` prepares the first automatic publication through the existing GitHub release workflow. The GitHub release assets remain an installation option.

The `v0.2.51` tag is retained for traceability. Its release workflow was canceled with macOS 14 jobs queued during GitHub's [announced retirement and brownout period](https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/); no release assets or npm packages were published for it. Version `0.2.52` moves the macOS validation matrix to `macos-15` and keeps both Node.js 22 and 24.

## Release gates

The project owner has authorized public distribution under the [MIT license](../LICENSE). Release packaging must preserve that license and the vendored component notices described in [third-party notices](../THIRD_PARTY_NOTICES.md). Validate third-party redistribution requirements before publishing bundled assets.

Changes go through GitHub pull requests and the repository's build and test workflows. To release, update the CLI and plugin manifests and the CLI lockfile to the same version, merge to `main`, then push a matching `vX.Y.Z` tag. The release workflow checks that the tag points to the exact checked-out commit on `origin/main`, repeats CI, and validates versions and license metadata before packaging. Release automation must run validation against the exact tagged commit, build the CLI from its lockfile, independently install it, initialize SQLite and query the task list, and attach the CLI tarball and checksum to a GitHub Release. `node scripts/release-artifacts.mjs [output-directory]` requires an empty destination; use a fresh directory for each attempt so stale TUI or earlier release assets cannot enter the release. It refuses existing files without deleting them. A failed check must prevent release publication. Never use CI logs or release assets to distribute secrets or private evaluation data.

## Release tag protection

Release tags `v*` have a separate protection policy from `grounds/candidates/*` and `grounds/deliveries/*`. Only repository administrators may create release tags, and existing release tags must not be moved or deleted. Configure separate rulesets so that the administrator exception for tag creation does not bypass update or deletion restrictions. Inspect the effective GitHub rules before cutting a release; archive namespace readiness does not establish release tag protection.

Version `0.2.50` is the first release candidate for this GitHub distribution process. Its version number does not establish production maturity, stable API guarantees, or completion of the operating-system test matrix. Publish only after the checks for its exact tag pass, and describe unresolved limitations in the release notes.

The earlier `v0.2.49` tag is retained for traceability. Its release validation found a verification pagination ordering defect, so no release packages were published for that tag. Version `0.2.50` fixes ordering across fractional timestamp precisions and legacy UTC formats, with regression coverage for page boundaries.

Upgrading to `0.2.50` invalidates version 1 opaque list cursors, including candidate, verification, and issue activity lists. Their old timestamp keys may have lost precision and cannot be safely resumed. A saved version 1 cursor returns `VALIDATION_ERROR`; restart from the first page without `--cursor`, then follow the newly returned cursors. The independent verification cursors returned by `candidate show` and the candidate-bound verification directory also require a fresh first page; unversioned inner cursors are rejected even inside an otherwise valid directory envelope. This changes pagination state only, not stored timestamps or artifact digests.

The ordering correction can change a **derived verification-set digest** even when the stored reports are unchanged. Existing selections retain their recorded snapshots and may report `verification_changed` / `SELECTION_VERIFICATION_CHANGED`; integration snapshots may likewise differ. Review the current verification set and explicitly select the candidate again before proceeding with delivery. The upgrade does not migrate old ledger entries, rewrite selection history, or substitute the old digest. Stored artifact digests remain unchanged.

## Install a GitHub release

After a release is approved and available, download the CLI tarball and checksum from the same [GitHub Release](https://github.com/MaybeLL/Ground/releases). Verify the checksum before installation. Current-source assets are named `maybell-grounds-X.Y.Z.tgz` and `SHA256SUMS`. Install the downloaded CLI using `npm install -g /path/to/cli.tgz --registry=https://registry.npmjs.org`, substituting its actual path. This does not require publication on npm. Native modules may need local build tools.

Do not install assets from an untrusted fork. Retain the release commit and checksums when reporting a problem. Local databases and workspace state require their own backup and migration procedures; upgrading the executable alone does not authorize a database migration.

## First npm publication (historical)

The following records the completed two-package bootstrap before TUI retirement; it is not the current release procedure. Keep existing package versions immutable. Current releases publish only the CLI as described below.

The npm account or organization must own the `@maybell` scope. Verify the account email and enable two-factor authentication. Public scoped packages use `--access public`; a paid private-package plan is not required. Consult the [npm public package guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/).

Keep the GitHub Actions repository variable `NPM_PUBLISH_ENABLED` unset during bootstrap. Merge the release changes and create a new matching version tag through the release process above. Existing tags must not be moved. Wait for validation, independent tarball installation tests and GitHub Release publication to succeed for that exact tag.

Run the following from the repository root for the first npm release, substituting the release version if necessary. GitHub now resolves the former `MaybeLL/grounds-open` address to `MaybeLL/Ground`; use the actual repository name for npm metadata and trusted publishing.

```sh
gh release download v0.2.52 --repo MaybeLL/Ground \
  --dir output/npm-bootstrap/0.2.52 \
  --pattern 'maybell-grounds-*.tgz' --pattern SHA256SUMS
cd output/npm-bootstrap/0.2.52
shasum -a 256 -c SHA256SUMS
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

Confirm the authenticated account is `maybell`, both expected tarballs are present, and both checksums passed. Review their contents with `tar -tf` before publishing. Publish the exact GitHub-built tarballs, completing npm's interactive authentication prompts:

```sh
npm publish ./maybell-grounds-0.2.52.tgz --access public --registry=https://registry.npmjs.org/
npm publish ./maybell-grounds-tui-0.2.52.tgz --access public --registry=https://registry.npmjs.org/
```

The first npm publication was completed for `0.2.52` using these GitHub-built tarballs. Do not run these bootstrap commands again for an already published version.

New uploads are scanned before becoming installable. A successful upload can precede registry availability by several minutes; wait for both exact versions to appear and verify their integrity before announcing availability. See [npm publish-time scanning](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/).

Source-directory `npm publish` is intentionally blocked by `prepublishOnly`: build and validation run in GitHub Actions, and the tarballs are the release artifacts. `npm publish <tarball>` does not run that source-directory hook. Do not bypass it with `--ignore-scripts` or replace a released version with different bytes. Initial local publication does not provide GitHub OIDC provenance.

## Enable automatic npm releases

Open the CLI package's npm Settings and configure its GitHub Actions Trusted Publisher with these exact fields:

| Field | Value |
| --- | --- |
| Organization or user | `MaybeLL` |
| Repository | `Ground` |
| Workflow filename | `release.yml` |
| Environment name | Leave blank |
| Allowed actions | Enable direct `npm publish` |

The workflow uses GitHub-hosted runners, Node.js 24 and npm 11.19.0, with `id-token: write` only on the npm publishing job. It needs no stored npm token. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). Do not configure a caller workflow such as `ci.yml` or `validate.yml` as the publisher.

A new trusted publisher must complete its first successful publish within two days. That first publish binds it to the repository identity and removes the initial expiry. After configuring the CLI publisher, release a new CLI/plugin version through this workflow and verify that its trust configuration is validated; do not overwrite or republish the bootstrap version. If the configuration expires before its first publish, recreate it before retrying. See [trusted publisher expiry](https://docs.npmjs.com/trusted-publishers/#trusted-publisher-configuration-expiry).

After the CLI trusted publisher is configured, set the GitHub Actions repository variable `NPM_PUBLISH_ENABLED` to `true` under Settings → Secrets and variables → Actions → Variables. This enables npm publication for subsequent version tags; enabling the variable does not publish the bootstrap version again. Each tag still runs all validation, source and license checks, package installation smoke tests, and GitHub Release publication before the npm job. npm receives the same checksummed tarballs as the GitHub Release, with provenance.

The workflow has one CLI npm publishing job. If publication fails, rerun **failed jobs only** after resolving the cause. Successful npm versions are immutable; rerunning an already successful publication will fail rather than overwrite it. A GitHub Release can exist while an npm publication is incomplete. Confirm the CLI npm version is present before announcing npm availability:

```sh
npm view @maybell/grounds@0.2.53 version --registry=https://registry.npmjs.org/
npm install -g @maybell/grounds@0.2.53 --registry=https://registry.npmjs.org/
grounds --help
```

Replace `0.2.53` with the version being verified. Installation requires Node.js 22.13 or later; the assembled CLI includes Node-API binaries for macOS and glibc Linux on x64 and arm64. Source builds use node-gyp. Test npm installation in a fresh prefix or environment so a source checkout's dependencies cannot hide missing package contents.

The validation workflow installs the staged tarball with only Node, npm and Git on PATH. It records repository setup time and the elapsed time from installation through an accepted work. Its four native jobs exercise Linux and macOS on x64 and arm64. The assembled package is verified again before the release workflow can publish it.

For a manual hosted acceptance, set `GROUNDS_ACCEPTANCE_GITHUB_TOKEN` in the environment with contents-write access to a dedicated fixture repository. Run the following from the repository root after building. The check creates a unique delivery tag in that repository and compares the remote tag with the worktree commit. Use a fresh output directory for each run.

```sh
node scripts/release-artifacts.mjs /tmp/grounds-hosted-acceptance --github-remote https://github.com/OWNER/FIXTURE.git
```
