# Getting started

## Prerequisites

The staged refactor tarball on macOS and glibc Linux (x64 or arm64) needs Node.js 22.13 or newer, npm and Git. Building a checkout from source also requires Python 3 and a C/C++ toolchain.

Install the staged file with `npm install -g /path/to/package.tgz`. Follow [npm installation](../README.md#install-a-published-version) for a published version, or use the [source build](../README.md#build-from-source). Inspect installed commands without opening a database:

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
grounds help --json
```

`npm link` modifies your local npm installation; it does not publish a package.

## Configure a ledger

SQLite is available for a local ledger. MySQL and PostgreSQL provide networked ledger options; CI includes TLS database conformance checks for both alongside SQLite. Use the run results for the exact commit to determine which checks passed.

Run `grounds init --help` before configuring a database. `grounds init` validates the selected SQL connection and pins the database identity before writing canonical local configuration. Bare `grounds init` creates the default SQLite ledger without prompting. Empty MySQL and PostgreSQL targets require explicit initialization authorization. An existing ledger must have the current work protocol and schema. See the [configuration contract](contracts/v1/README.md#local-config) for credential sources and safety rules.

The development refactor does not provide brand or data-directory migration (`migrate patchledger` / `migrate data`); historical directories are ignored and never moved or deleted automatically. Use a fresh configuration and data root for this refactor. Old business tables and SQL schema migration remain temporarily while the model cutover is completed; see the [retirement boundary](architecture.md#legacy-retirement).

Keep credentials outside the repository. Do not reuse production credentials for development or CI. A GitHub checkout and a SQL ledger are separate resources: copying code is not a database migration.

## Start a workflow


The legacy TUI has been retired from this source tree. Use `grounds help --json` and the development skill; a new work-model TUI is not implemented.

Use the [development skill](../plugins/grounds/skills/grounds/SKILL.md) to publish a task, deliver a Git commit and request an independent gate.
