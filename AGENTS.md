# Repository guidance

Grounds is an MIT-licensed project hosted at https://github.com/MaybeLL/grounds-open.
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
