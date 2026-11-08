# Repository guidance

Grounds is an MIT-licensed project hosted at https://github.com/MaybeLL/Ground.
GitHub is the canonical remote; builds and releases run in GitHub Actions.

- CLI code and tests live in `typescript/`. The legacy TUI package has been retired; a new work-model TUI is not implemented.
- Agent skills live in `plugins/grounds/`; distribution and CLI workflow tests live in `typescript/test/`. Legacy Python evaluation tools and their tests have been retired.
- Read `CONTRIBUTING.md` for build and test prerequisites. Keep CLI, plugin and CLI lockfile versions aligned.
- Use ESM TypeScript, focused regression tests for behavior changes, and Conventional Commits.
- Never commit credentials, local configuration, private evaluation cases or internal acceptance records.
- Preserve third-party license notices. Run `node scripts/check-docs.mjs` and relevant tests after changes.
- Work delivery archives must push the tag and read back the exact commit before recording delivery. Follow D147 for the role of tag protection evidence.
- Follow the workspace's shared progress-record instructions when present. Do not create a project-local `PROCESS.md`.
- `CLAUDE.md` is a relative symlink to this file; maintain instructions here only.

## Releases

- Read the [release process](docs/releases.md) before preparing a release; it defines validation gates, tag protection, npm setup, and recovery. Automation lives in [release.yml](.github/workflows/release.yml).
- Update the CLI and plugin manifests and the CLI lockfile to the same `X.Y.Z` version. Merge the change to `main` through a pull request, then create and push a new matching `vX.Y.Z` tag on the merged commit. Existing release tags and published versions are immutable.
- The tag workflow validates the exact source, builds checksummed tarballs, creates a GitHub Release, and publishes the CLI npm package through OIDC. Automatic npm publication requires both trusted publishers and `NPM_PUBLISH_ENABLED=true`; verify those settings using the release guide. Source-directory `npm publish` is intentionally blocked.
- Before announcing npm availability, confirm the CLI package version, verify its integrity and provenance, and test a fresh CLI installation. A successful upload can precede installability while npm scans the packages; follow the release guide's verification steps.

## Design and documentation

- Read the [project vision and core principles](docs/vision.md) before any design, planning, or significant change. It is the highest-level guidance: every design must be consistent with it. Resolve conflicts by changing the design or, with explicit owner approval, revising the vision first and recording the reason in the relevant decision; never leave them in conflict.
- Before changing interfaces, module responsibilities, or error handling, read [software design principles](docs/software-design.md). Prefer deep modules and information hiding; reduce caller knowledge and total complexity rather than optimizing function length.
- Follow [documentation maintenance](docs/documentation.md). Use [the documentation index](docs/README.md) to find relevant current concepts, architecture, and accepted decisions; read applicable module guidance before editing.
- Update concepts for changed business rules, architecture for changed implementation boundaries, and decisions for significant choices and their rationale. Deliver affected documentation with the implementation; briefly explain when no documentation change is needed.
- Treat schemas and source as interface/implementation evidence, not automatic authority to override accepted business rules. Investigate discrepancies instead of silently rewriting the rules.
- For unified Agent evaluation work, read and maintain the [evaluation development agreement](docs/decisions/0001-unified-agent-evaluation.md). Record new discussion decisions there and distinguish accepted requirements, open proposals, and verified implementation.
