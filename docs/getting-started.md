# Getting started

## Prerequisites

Install Node.js 22.13 or later, npm, Git, Python 3, and native build tools. The CLI includes native dependencies, so a downloaded npm tarball still needs a compatible operating system and toolchain. The CI validation matrix targets Linux (Ubuntu 24.04) and macOS (macOS 15), each on Node.js 22 and 24. Consult the release workflow for the exact tag to establish which checks passed. Windows is not validated.

Follow [npm installation](../README.md#install-a-published-version) for a published version, or use the [source build](../README.md#build-from-source). Inspect installed commands without opening a database:

```sh
grounds help --json
```

From a source checkout, the equivalent command is:

```sh
node typescript/dist/src/bin.js help --json
```

To expose the commands in your shell from a local checkout:

```sh
(cd typescript && npm link)
(cd tui && npm link)
grounds help --json
```

Use matching CLI and TUI versions. `npm link` modifies your local npm installation; it does not publish a package.

## Configure a ledger

SQLite is available for a local ledger. MySQL and PostgreSQL provide networked ledger options; CI includes TLS database conformance checks for both alongside SQLite. Use the run results for the exact commit to determine which checks passed.

Run `grounds init --help` before configuring a database. `grounds init` validates the selected SQL connection and pins the database identity before writing canonical local configuration. An empty database requires explicit initialization authorization; an existing database may require a separately authorized schema migration. See the [configuration contract](contracts/v1/README.md#local-config) for credential sources and safety rules.

Keep credentials outside the repository. Do not reuse production credentials for development or CI. A GitHub checkout and a SQL ledger are separate resources: copying code is not a database migration.

## Start a workflow

Use `grounds help --json` for the installed command surface and the [workflow skill](../plugins/grounds/skills/grounds/SKILL.md) for the supported requirement → candidate → independent verification → delivery workflow. The [contracts](contracts/v1/README.md) define structured inputs and outputs. For GitHub repositories, follow [GitHub archive onboarding](../plugins/grounds/skills/grounds/references/github-archive-onboarding.md) to configure authentication, immutable tag rules, and the ledger binding. Candidate submission also checks archive protection on the target host; a repository plan without those protections cannot satisfy that requirement.

To inspect the terminal interface after building both components, run `grounds-tui --help`. Configure a ledger before opening data-backed views.
