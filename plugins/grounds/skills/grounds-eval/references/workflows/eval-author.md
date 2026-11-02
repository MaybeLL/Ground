<a id="author-evaluation-tasks"></a>

# Prepare evaluation assets

Read [shared preparation](../../../../references/preparation.md) and inspect `grounds eval --help --json`. The retained asset CLI is transitional; it is not a managed agent runtime.

Write public questions separately from private rubrics and reference evidence. Every required grading point must be supported by the public request and authoritative sources. Freeze exact task/grader versions, document uncertainty and keep private materials out of code/documentation repositories exposed to measured agents.

For an explicitly requested legacy asset publication, use current [contract definitions](../../../../references/contracts/v1/README.md) and the installed CLI, not an obsolete converter. `eval qa publish --file FILE` publishes QA definitions; `eval grader publish --file FILE` publishes a private grader. Both require actual valid input and explicit attribution (`--agent-id` and `--agent-name`) and return operation IDs to preserve for retries. Read the exact resulting versions back before proceeding.

Use `eval suite create --name NAME` and documented version-checked membership commands only when suite publication is authorized. Do not assume new `task` identities are accepted by legacy coding grader fields. Do not manufacture execution validation while writing an environment definition.

A request to author and run can complete its authoring portion, but the removed automated runner is a real execution gap. Preserve the definitions and report the run as **not executed**; do not initialize an empty experiment merely to imply progress.
