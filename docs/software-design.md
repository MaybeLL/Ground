# Software design principles

These are maintenance rules for Grounds, inspired by John Ousterhout's *A Philosophy of Software Design*. Apply them when designing or changing interfaces, module responsibilities, and failure handling. They are judgment criteria, not quotas for classes, methods, abstractions, or documents.

## Source and reading scope

Reviewed on 2026-10-30: the author's [book page](https://web.stanford.edu/~ouster/cgi-bin/book.php), official [second-edition extract](https://web.stanford.edu/~ouster/cgi-bin/aposd2ndEdExtract.pdf), and [Stanford CS 190 discussion outline](https://web.stanford.edu/~ouster/cs190-winter24/lectures/aposd/). The extract covers Chapter 6, sections 9.8–9.9 and 12.6 with surrounding discussion, and Chapter 21. This is not a review of the complete book. The repository-specific requirements below are our application of these ideas, not quotations or claims about the author's treatment of Grounds.

The extract emphasizes reducing change amplification, cognitive load, and hidden dependencies; making modules useful through simple interfaces; separating general mechanisms from specialized policy; documenting information code cannot express clearly; and making important constraints explicit. Splitting functions is worthwhile when it improves understanding, not merely when it reduces line counts. The course also discusses strategic development, comparing designs, and cautious elimination of error cases.

## Maintenance rules

### Reduce complexity across the whole change

Consider callers, implementation, configuration, and tests together. A short helper is not an improvement if callers must now coordinate extra state or reconstruct its assumptions. Improve the design within the task's scope; do not turn a focused fix into an unrelated rewrite. Disclose consequential remaining design debt rather than hiding it behind a new layer.

### Prefer deep modules and information hiding

A module may be a function, class, or package. Its interface includes ordering requirements, errors, side effects, and invariants as well as types. Keep implementation knowledge inside the module that owns it. Do not require TUI callers to understand ledger SQL or hosting-specific permission responses merely to consume a result.

Choose extraction or consolidation based on whether responsibilities can be understood independently. Avoid pass-through wrappers without a clear policy, translation, or ownership role. Necessary adapters are legitimate; short code alone is not evidence of a bad abstraction. Depth does not justify mixing unrelated responsibilities into a large module.

### Generalize mechanisms within present needs

Keep presentation choices out of ledger operations and hosting-specific behavior inside the appropriate implementation. Prefer operations that express domain meaning over flags for particular callers. Do not erase meaningful GitHub/GitLab differences or invent a configurable framework for hypothetical requirements. A shared operation must still express current behavior precisely and be convenient for current callers.

### Make important business distinctions explicit

Use established domain names. Preserve distinctions among archival, verification, selection, and delivery in types, results, and documentation. A generic success flag must not imply that every stage succeeded. If several callers repeat a business rule, identify its owner and consolidate enforcement where appropriate; independently required trust checks must remain at their boundaries.

### Simplify error handling without hiding failures

Use representations and operations that avoid unnecessary special cases when business semantics permit it. Define retry and idempotency behavior explicitly, especially when SQL and remote Git operations can succeed separately. Preserve diagnostic causes and distinguish absent, unknown, and failed states.

Archive authorization, protection checks, invalid evidence, and incompatible state must not become success or empty results to simplify callers. Recovery must respect existing authorization and compatibility rules. Error aggregation must preserve the information needed to determine the safe next action.

### Write interfaces and explanations together

For a new or materially changed interface, write down its purpose, inputs, observable effects, failure behavior, and important constraints before finalizing the implementation. Difficulty explaining it is a reason to revisit the design.

Keep local implementation rationale beside code; keep business rules and cross-module decisions in their designated documents. Comments should explain assumptions and guarantees missing from types, not narrate statements. Do not remove useful comments merely because names seem descriptive.

### Compare alternatives when the decision is consequential

For a new public interface, cross-module boundary, or costly-to-reverse representation, compare at least two plausible designs before committing to one. Assess caller knowledge, dependencies, failure behavior, compatibility, and validation cost. A short comparison is sufficient; ordinary fixes need neither multiple implementations nor a new decision record. This rule does not require spawning agents.

### Verify the promised behavior

Use focused behavior tests at the appropriate interface and relevant integration checks for external boundaries. Test the invariants and failures affected by the change, rather than reproducing implementation steps. Retain evidence for performance-driven tradeoffs; do not trade clarity for an unmeasured optimization.

## Review prompts

For a substantive design change, reviewers should be able to answer:

- What knowledge or coordination has been removed from callers?
- Which module owns the changed rule, and which dependencies remain necessary?
- Are business distinctions, failure semantics, and compatibility still explicit?
- Do the code, comments, current documentation, and tests agree?

Explain meaningful exceptions in the PR. Use [documentation maintenance](documentation.md) to decide where persistent knowledge belongs; do not reproduce this checklist in every small change.
