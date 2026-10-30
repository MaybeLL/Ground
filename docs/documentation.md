# Documentation maintenance

Documentation is shared project context for people and maintenance agents. Write for readers who have no access to the authoring conversation. These rules apply to documentation and code changes; scale the work to the actual impact.

## Responsibilities

| Location | Responsibility |
| --- | --- |
| Root README | Product purpose, use cases, and first-use entry points |
| AGENTS.md | Stable maintenance instructions and task-based navigation |
| docs/README.md | Index of available project knowledge |
| docs/concepts/ | Current business terms, relationships, rules, and exceptions |
| docs/architecture.md | Current implementation structure, dependencies, boundaries, and source entry points |
| Module maintenance guides | Local responsibilities, modification guidance, and validation |
| docs/decisions/ | Significant choices, reasons, alternatives, and replacement history |
| Source, schemas, and tests | Interface definitions, implementation, and behavior evidence |
| docs/research/ | Investigations and proposals, not automatically adopted policy |
| plugins/grounds/ | Product skills for agents using Grounds |

Concepts answer what the business means and requires; architecture explains how the implementation supports it; decisions explain why choices were made. Reference the authoritative explanation instead of duplicating it. Not every location above exists yet: create a substantive document when needed, add it to the index, and never link to an empty or nonexistent placeholder.

Keep existing machine-readable contracts in docs/contracts/v1/. Do not introduce a separate prose contract hierarchy that duplicates schemas. Explain business meaning in concepts, and significant rationale in decisions. Existing contract guides can retain useful operational explanations until they are deliberately migrated with links preserved.

Package READMEs also serve installed-package users; keep internal maintenance detail in separate linked guides. Product skills teach use of Grounds and do not substitute for documentation about maintaining its implementation.

## Reading and updating

Before editing, use the index and relevant module guidance to locate the current rules and implementation. Read accepted decisions when changing the choice they explain. Do not load all documentation for every task.

| Change | Required documentation consideration |
| --- | --- |
| Business meaning, lifecycle, invariant, or exception | Update the corresponding concept |
| Component responsibility, dependency direction, storage boundary, or major source entry point | Update architecture or module guidance |
| Significant business or technical tradeoff | Add or update a decision and link the current explanation |
| CLI, schema, configuration, or installation behavior | Update affected help, schemas, guides, examples, and distributed assets |
| Fix restoring existing intended behavior | Usually preserve current rules; add clarification only if needed |
| Local refactoring with unchanged boundaries | Usually no architecture or decision change |

Ship affected documentation with its implementation. In the PR or handoff, identify documentation impact, or briefly explain why none is needed. Do not create a decision for every fix or rewrite documentation simply to make a checklist pass.

## Current rules and decisions

Concepts and architecture describe current behavior and intended guarantees, with known discrepancies explicitly identified. Do not silently change an accepted rule to match a bug in the implementation.

Each decision records its status (proposed, accepted, superseded, or rejected), date, scope, context, choice, significant alternatives, consequences, and relevant implementation/validation references. For an accepted but unimplemented choice, state that implementation is pending; acceptance alone does not establish current behavior. Superseded decisions link to their replacement. Maintain a concise decision index when the first record is added.

When a decision is implemented, update the current concept or architecture description so readers need not reconstruct current rules from historical records. Correct factual errors transparently; do not rewrite old rationale to hide that a decision changed.

## Evidence and validation

Prefer stable file and symbol references over copied implementation or line numbers alone. State the source of generated or distributed copies and validate synchronization when changing them. Dates and metadata are not proof of semantic accuracy.

Run `node scripts/check-docs.mjs` and `git diff --check` after documentation edits. Run relevant behavior or example checks when instructions or executable examples change. Review business meaning and source agreement separately: link checks cannot establish these.

Keep credentials, personal environment details, private evaluation cases, and internal acceptance records out of public documentation. Follow existing shared progress-record rules; do not create a project-local PROCESS.md. Research becomes policy only through an explicit adoption change, with the policy linked from the maintenance entry points.
