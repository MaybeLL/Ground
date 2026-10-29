---
name: grounds-eval
description: Author Grounds evaluation tasks and private Graders, run or resume Coding and QA experiments, regrade frozen artifacts, and compare evidence-backed reports. Use for evaluation work; ordinary development and Candidate Verification use grounds.
---

# Evaluate with Grounds

Coordinate evaluation work using the user's existing Agent and the Grounds CLI. The CLI remains the authority for persisted state. Locate the exact task, suite, snapshot, experiment or journal from the conversation and read-only queries; ask only when the target remains ambiguous. A progress question authorizes inspection, not a new experiment.

Read [shared preparation](../../references/preparation.md) before CLI work. It exports the helper root used by `python3 "${GROUNDS_SKILL_ROOT:-$PLUGIN_ROOT}/scripts/grounds_agent.py"`. Select one active workflow from the current persisted state and load only that workflow:

| User purpose | Workflow |
| --- | --- |
| Create or revise tasks, private Graders, suites or environment definitions | [Author evaluation assets](references/workflows/eval-author.md) |
| Start/resume experiments, run Coding or QA evaluation, regrade, inspect progress or compare reports | [Run evaluation](references/workflows/eval-run.md) |
| Ordinary development, all-Criteria Candidate Verification, code explanation or delivery | [Grounds development](../grounds/SKILL.md) |
| Discover and repair documentation coverage gaps through doc-only QA | [Knowledge improvement](../grounds-knowledge-improve/SKILL.md) |

For a combined author-and-run request with assets still to create, the active workflow is author. Read `eval-author.md` first; defer `eval-run.md` and its execution-only references until authoring has returned a successful structured result. Preserve the requested run as the next step. Once the authoring result is fixed and inspected, load the run workflow and continue within the existing scope. Keep existing authorization; do not add per-task approvals. Record exact version bindings, journal location, completed results, unresolved blockers and the next authorized action. Resume from actual persisted state and retained evidence rather than creating duplicate runs.

The coordinator may see private Graders. A measured developer receives only the public task/context and permitted tools in a fresh restricted session; a grader uses a separate evaluator context. Never forward the coordinator transcript or private definitions into the measured session. Reading another reference does not establish isolation. Follow each workflow's host capability and manual-handoff requirements before claiming an independent or blind result.

To locate assets or experiment progress, use the lightweight lists instead of downloading full records: `eval experiment list --view summary` (Run counts by open/closed), `eval run list --experiment ID --state open --view summary`, `eval grader list --qa ID --limit 50`; page with `--cursor`, read bodies and evidence only through `show`/report commands. Summary pages are not complete records and open/closed counts are not evaluation results. A `LIST_CHANGED` error means restart from the first page.

A Grader may assess only part of an Issue; its result does not replace all-Criteria independent Verification. Report configured conditions, observed execution, missing evidence and actual results distinctly. Do not silently rerun until pass or claim effectiveness from configuration alone.
