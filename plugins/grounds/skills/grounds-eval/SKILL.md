---
name: grounds-eval
description: Inspect Grounds evaluation assets and recorded experiments, or prepare private evaluation definitions. Automated experiment execution is unavailable during the work-model cutover; ordinary coding and independent gates use grounds.
---

# Evaluation assets during the model cutover

Read [shared preparation](../../references/preparation.md). Invoke `grounds` directly, without a Python coordinator or provider-specific capture process.

**Current boundary:** the legacy `eval` CLI still stores/reads assets and recorded results. Its Python experiment runner, Codex answer/grading capture, preparation proxy and repository-snapshot adapter have been removed. New managed execution and experiment orchestration arrive in P4/P5; they are not available now. Do not start new experiments through a deleted runner, fabricate environment/termination receipts, or substitute a new shell/Python coordinator.

| Intent | Workflow |
| --- | --- |
| Prepare or explicitly publish evaluation definitions using the retained CLI | [Author assets](references/workflows/eval-author.md) |
| Read recorded progress, results and comparisons; handle a request to run | [Execution boundary and reporting](references/workflows/eval-run.md) |
| Implement code and obtain an independent gate | [Grounds](../grounds/SKILL.md) |
| Prepare source-backed knowledge questions or repair proposals | [Knowledge improvement](../grounds-knowledge-improve/SKILL.md) |

Use bounded lists and exact identifiers. A progress request never authorizes a run. Private rubrics, proposed answers and coordinator conversations are not public task materials. An asset definition or a stored `open` record is not evidence that any model ran.

The retained evaluation record model is not the new TaskRun/Grading model. Do not pass a new task/run ID to an Issue/Candidate-based command or invent a mapping. See [retained interfaces](references/evaluation.md) for the limited asset/query surface.
