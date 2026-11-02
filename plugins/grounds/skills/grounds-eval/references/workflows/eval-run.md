# Execution boundary and recorded reports

The Python coordinator and provider-specific capture runtime are retired. This skill does not start, resume or retry automated Coding/QA experiments until the new managed execution path exists. Do not silently substitute a fresh model invocation, fabricate an answer/grade capture, or infer completion from old local journals.

For a request to run, explain the missing runtime and retain the prepared task/grader versions and requested conditions. Ordinary coding development can instead use [Grounds](../../../grounds/SKILL.md), but its independent gate is not an equivalent measured experiment.

## Read-only progress

```bash
grounds eval experiment list --view summary --limit 50 --json
grounds eval run list --experiment "$EXPERIMENT_ID" --view summary --limit 50 --json
grounds eval experiment report "$EXPERIMENT_ID" --json
grounds eval compare "$EXPERIMENT_A" "$EXPERIMENT_B" --json
```

Use `--cursor` to continue bounded lists. A `LIST_CHANGED` response means the collection changed; restart the read, not the experiment. Open/closed counts are state, not quality conclusions. Read relevant result bodies and evidence before attributing causes.

For historical A/B reports, compare exact versions, model/configuration, tool/material boundaries, budgets and all attempts. Separate `error/not_executed` from business failure; never pick the best attempt or hide missing evidence. The absence of a current runner does not authorize altering old result records.

## Incomplete runs

Report unresolved state and known evidence. Do not claim a process has stopped based on a database record. Before any separately authorized cleanup, inspect ownership using the actual host tools; no broad process-name kill or unrelated resource deletion. Unknown invocation outcomes must not trigger another invocation.
