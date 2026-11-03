# Repository guidance

Grounds is an MIT-licensed project hosted at https://github.com/MaybeLL/Ground.
GitHub is the canonical remote; builds and releases run in GitHub Actions.

- CLI code and tests live in `typescript/`; terminal UI code and tests live in `tui/`.
- Agent skills live in `plugins/grounds/`; distribution and CLI workflow tests live in `typescript/test/`. Legacy Python evaluation tools and their tests have been retired.
- Read `CONTRIBUTING.md` for build and test prerequisites. Keep CLI, TUI, plugin and lockfile versions aligned.
- Use ESM TypeScript, focused regression tests for behavior changes, and Conventional Commits.
- Never commit credentials, local configuration, private evaluation cases or internal acceptance records.
- Preserve third-party license notices. Run `node scripts/check-docs.mjs` and relevant tests after changes.
- Candidate archiving must fail closed when the archive tag cannot be pushed or read back at the exact commit. Under current code, GitHub archive checks also fail closed when ruleset protection cannot be established; [D147](docs/decisions/0001-unified-agent-evaluation.md#d147归档只要求推送远端标签并读回核对保护等级只作记录已确认待实现) changes the target so that protection is recorded, not required. Follow D147 when implementing that change.
- Follow the workspace's shared progress-record instructions when present. Do not create a project-local `PROCESS.md`.
- `CLAUDE.md` is a relative symlink to this file; maintain instructions here only.

## Releases

- Read the [release process](docs/releases.md) before preparing a release; it defines validation gates, tag protection, npm setup, and recovery. Automation lives in [release.yml](.github/workflows/release.yml).
- Update the CLI, TUI, plugin manifests, and both lockfiles to the same `X.Y.Z` version. Merge the change to `main` through a pull request, then create and push a new matching `vX.Y.Z` tag on the merged commit. Existing release tags and published versions are immutable.
- The tag workflow validates the exact source, builds checksummed tarballs, creates a GitHub Release, and publishes both npm packages through OIDC. Automatic npm publication requires both trusted publishers and `NPM_PUBLISH_ENABLED=true`; verify those settings using the release guide. Source-directory `npm publish` is intentionally blocked.
- Before announcing npm availability, confirm both package versions, verify their integrity and provenance, and test a fresh CLI/TUI installation. A successful upload can precede installability while npm scans the packages; follow the release guide's verification steps.

## Design and documentation

- Read the [project vision and core principles](docs/vision.md) before any design, planning, or significant change. It is the highest-level guidance: every design must be consistent with it. Resolve conflicts by changing the design or, with explicit owner approval, revising the vision first and recording the reason in the relevant decision; never leave them in conflict.
- Before changing interfaces, module responsibilities, or error handling, read [software design principles](docs/software-design.md). Prefer deep modules and information hiding; reduce caller knowledge and total complexity rather than optimizing function length.
- Follow [documentation maintenance](docs/documentation.md). Use [the documentation index](docs/README.md) to find relevant current concepts, architecture, and accepted decisions; read applicable module guidance before editing.
- Update concepts for changed business rules, architecture for changed implementation boundaries, and decisions for significant choices and their rationale. Deliver affected documentation with the implementation; briefly explain when no documentation change is needed.
- Treat schemas and source as interface/implementation evidence, not automatic authority to override accepted business rules. Investigate discrepancies instead of silently rewriting the rules.
- For unified Agent evaluation work, read and maintain the [evaluation development agreement](docs/decisions/0001-unified-agent-evaluation.md). Record new discussion decisions there and distinguish accepted requirements, open proposals, and verified implementation.
