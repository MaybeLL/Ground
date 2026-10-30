# Repository guidance

Grounds is an MIT-licensed project hosted at https://github.com/MaybeLL/Ground.
GitHub is the canonical remote; builds and releases run in GitHub Actions.

- CLI code and tests live in `typescript/`; terminal UI code and tests live in `tui/`.
- Agent skills and their Python tests live in `plugins/grounds/`.
- Read `CONTRIBUTING.md` for build and test prerequisites. Keep CLI, TUI, plugin and lockfile versions aligned.
- Use ESM TypeScript, focused regression tests for behavior changes, and Conventional Commits.
- Never commit credentials, local configuration, private evaluation cases or internal acceptance records.
- Preserve third-party license notices. Run `node scripts/check-docs.mjs` and relevant tests after changes.
- GitHub archive checks must fail closed when protection or authorization cannot be established.
- Follow the workspace's shared progress-record instructions when present. Do not create a project-local `PROCESS.md`.
- `CLAUDE.md` is a relative symlink to this file; maintain instructions here only.

## Design and documentation

- Before changing interfaces, module responsibilities, or error handling, read [software design principles](docs/software-design.md). Prefer deep modules and information hiding; reduce caller knowledge and total complexity rather than optimizing function length.
- Follow [documentation maintenance](docs/documentation.md). Use [the documentation index](docs/README.md) to find relevant current concepts, architecture, and accepted decisions; read applicable module guidance before editing.
- Update concepts for changed business rules, architecture for changed implementation boundaries, and decisions for significant choices and their rationale. Deliver affected documentation with the implementation; briefly explain when no documentation change is needed.
- Treat schemas and source as interface/implementation evidence, not automatic authority to override accepted business rules. Investigate discrepancies instead of silently rewriting the rules.
