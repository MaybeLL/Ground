# Retained evaluation interfaces

The old evaluation ledger remains temporarily during P1d. It is separate from the new Task/Work/Grading aggregates; there is no ID conversion or data migration.

Use `grounds eval --help --json` for the installed surface. Current retained operations include:

- `eval qa list/show/publish` for versioned QA definitions.
- `eval grader list/show/publish` for private graders.
- `eval suite list/show/create` and version-checked task membership edits.
- `eval snapshot show` for a fixed membership snapshot.
- `eval experiment list/show/report`, `eval run list/show`, `eval result show` and `eval compare` for stored facts.

Asset writes require explicit authorization, valid contract-shaped inputs, attribution and stable operation IDs. A published rubric is not a measured result. Exact command arguments and record shapes come from the installed help and [contracts](../../../references/contracts/v1/README.md).

Automatic capture, managed preparation, answer/grading invocation and coordinator-journal recovery are no longer distributed. Do not execute an old command recipe simply because the underlying legacy record API has not yet been removed. New evaluation assets, managed execution and experiments are planned for P3–P5.

Historical evidence may be inspected, but missing files or unavailable sources remain unknown. Do not reconstruct missing transcripts, rewrite metrics or present new code-development gates as equivalent old experiments.
