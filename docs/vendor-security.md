# Vendored renderer security review

Reviewed on 2026-10-30. The renderer now uses the unmodified official Mermaid 12.2.0 bundle, replacing 11.4.1. The [component inventory](../typescript/vendor/mermaid-components.json) records 67 exact component/version pairs, their sources, and license hashes. The review queried npm's public bulk advisory API with Mermaid and every inventoried package/version. No repository source or credentials were sent.

The old bundle matched 43 advisories across six package names. The new bundle matches seven advisories across DOMPurify and js-yaml, with no Mermaid advisory returned. These counts are package/version matches, not counts of confirmed exploitable Grounds vulnerabilities. A normal application `npm audit` does not inspect this checked-in bundle.

## Remaining advisory applicability

DOMPurify advisories [GHSA-55q2-fjhq-7xh7](https://github.com/advisories/GHSA-55q2-fjhq-7xh7), [GHSA-6688-9rhm-gjv2](https://github.com/advisories/GHSA-6688-9rhm-gjv2), and [GHSA-mrv2-3pqr-j5jr](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr) require IN_PLACE DOM sanitization and associated DOM/hook behavior. [GHSA-cg2g-xh64-v4q7](https://github.com/advisories/GHSA-cg2g-xh64-v4q7) concerns SAFE_FOR_TEMPLATES with DOM output modes and attached shadow content. [GHSA-c6gr-qvv4-5v3f](https://github.com/advisories/GHSA-c6gr-qvv4-5v3f) concerns XHTML parser mode. Inspection of the official bundle source map shows the Mermaid callers use string input and HTML string output; Grounds does not enable IN_PLACE, RETURN_DOM, SAFE_FOR_TEMPLATES, or an XHTML parser. Diagram-supplied configuration channels are rejected before rendering. These prerequisites are not present in the reviewed integration.

js-yaml advisories [GHSA-5p4m-2wfm-xmqj](https://github.com/advisories/GHSA-5p4m-2wfm-xmqj) and [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh) concern ordered-map resolution and merge-source work. The official bundle's diagram metadata loaders explicitly select `yaml.JSON_SCHEMA`, which does not resolve YAML ordered-map or merge types. Grounds also rejects leading YAML frontmatter and Mermaid directive blocks. Diagram input is capped at 50,000 characters and 500 edges. These restrictions are relevant mitigations, not a claim that all possible parser denial of service has been excluded.

## Controls to preserve

The [renderer](../typescript/src/plan-render.ts) retains strict Mermaid security, a five-diagram-type allowlist, rejection of configuration directives, math labels and obvious active HTML, a content security policy, and a separate shadow root inside a clipped parent for each diagram. Upgrading the bundle did not weaken these controls. The temporary render step occurs outside the shadow root, so final shadow containment alone is not a substitute for sanitization or dependency updates.

Re-evaluate this assessment whenever the bundle, allowed diagram types, sanitizer options, metadata schema, rendering context, or source filters change. Preserve browser security regression tests and scan the vendored inventory independently of npm runtime dependencies. This is a dated applicability assessment, not a guarantee of zero vulnerabilities or a substitute for testing the exact release build.
