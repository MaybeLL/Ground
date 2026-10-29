# Documentation

Grounds keeps a versioned ledger of requirements, issues, development runs, candidates, independent verification, and delivery records. Claims and test evidence are stored explicitly; an unverified claim is not a successful verification.

- [Getting started](getting-started.md): requirements, source build, and configuration.
- [Release process](releases.md): GitHub automation and distribution gates.
- [Machine-readable contracts](contracts/v1/README.md): versioned JSON interfaces and schemas.
- [Contribution guide](../CONTRIBUTING.md): local checks and pull requests.
- [Grounds workflow skill](../plugins/grounds/skills/grounds/SKILL.md): agent workflow entry point.

## Repository layout

| Path | Purpose |
| --- | --- |
| `typescript/src/` | CLI, SQL ledger, candidate and delivery operations |
| `typescript/test/` | CLI regression tests |
| `tui/src/` | Terminal review interface |
| `tui/test/` | Terminal UI and integration tests |
| `plugins/grounds/` | Agent skills, references, and plugin tests |
| `docs/contracts/v1/` | Versioned machine contracts |
| `.github/workflows/` | GitHub build, test, and release automation |

## Trust boundaries

The SQL ledger and local workspace are distinct. A Git push does not migrate a ledger or change its canonical repository binding. Candidate archival requires verifiable remote protections; missing permissions or unavailable hosting features must stop the operation rather than count as success. GitHub is the repository host for this project. Existing GitLab support is an optional integration for users working with their own GitLab repositories.

Do not commit database passwords, tokens, local configuration, captured user content, or generated workspace state. Internal development history and acceptance reports are deliberately excluded from these public-facing guides.
