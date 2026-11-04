# Documentation

Grounds keeps a versioned ledger of requirements, issues, development runs, candidates, independent verification, and delivery records. Claims and test evidence are stored explicitly; an unverified claim is not a successful verification.

- [Vision and core principles](vision.md): highest-level product positioning, core values, and design principles; every design builds on it.
- [Architecture](architecture.md): current structure of the work model and its SQL storage, with how to verify a storage change.
- [Getting started](getting-started.md): requirements, source build, and configuration.
- [GitHub archive onboarding](../plugins/grounds/skills/grounds/references/github-archive-onboarding.md): authentication and remote tag/readback requirements for `work deliver`.
- [Release process](releases.md): GitHub automation and distribution gates.
- [Vendored renderer security review](vendor-security.md): known advisories and integration boundaries.
- [Machine-readable contracts](contracts/v1/README.md): versioned JSON interfaces and schemas.
- [Contribution guide](../CONTRIBUTING.md): local checks and pull requests.
- [Software design principles](software-design.md): design and review rules inspired by Ousterhout's published material.
- [Documentation maintenance](documentation.md): responsibilities, reading routes, update triggers, and validation.
- [Decisions](decisions/README.md): accepted directions, alternatives, and implementation status.
- [通用 Agent 评测开发共识](decisions/0001-unified-agent-evaluation.md): living development guide for task, Agent, trajectory, artifact, grading, concurrency, and container boundaries; implementation pending.
- [通用 Agent 执行与评测目标模型（R2）](decisions/0001-target-model.md): accepted consolidated target model (D129–D147) with aggregates, invariants, application modules and flows; read before the full decision record; implementation pending.
- [通用 Agent 执行与评测实现方案](decisions/0002-implementation-plan.md): accepted second edition: local and container-managed work modes, bring-your-own-agent development first, then evaluation assets, then managed execution; devcontainer-based sandbox integration, local low-friction mode, migration and phases P0–P6.
- [Grounds workflow skill](../plugins/grounds/skills/grounds/SKILL.md): agent workflow entry point.
- [Agent documentation research](research/agent-documentation.md): historical evidence and proposals; follow the maintenance rules above for adopted policy.
- [开源 Agent Artifact 源码调研](research/agent-artifact-design.md): pinned-source comparison of ADK, LangChain and smolagents; findings and proposals, not implemented policy.
- [多 Agent 内核接入源码调研](research/multi-agent-kernel-adapters.md): Harbor、Vibe Kanban、ACP 与 Pi 的固定源码证据、接入难点和 Grounds 适配建议；尚未进行运行验收。

## Repository layout

| Path | Purpose |
| --- | --- |
| `typescript/src/` | CLI, SQL ledger, candidate and delivery operations |
| `typescript/test/` | CLI regression tests |
| `plugins/grounds/` | Agent skills, references, and plugin tests |
| `docs/contracts/v1/` | Versioned machine contracts |
| `.github/workflows/` | GitHub build, test, and release automation |

## Trust boundaries

The SQL ledger and local workspace are distinct. A Git push does not migrate a ledger or change its canonical repository binding. Candidate archival requires verifiable remote protections; missing permissions or unavailable hosting features must stop the operation rather than count as success. GitHub is the repository host for this project. Existing GitLab support is an optional integration for users working with their own GitLab repositories.

Do not commit database passwords, tokens, local configuration, captured user content, or generated workspace state. Internal development history and acceptance reports are deliberately excluded from these public-facing guides.
