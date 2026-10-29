# Getting started

## Prerequisites

Install Node.js 22.13 or later, npm, Git, Python 3, and native build tools. The CLI includes native dependencies, so a downloaded npm tarball still needs a compatible operating system and toolchain. Linux and macOS are the intended CI targets; Windows support is not established by these checks.

Follow the [source build](../README.md#build-from-source), then inspect the commands without opening a database:

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

Run `grounds init --help` before configuring a database. `grounds init` validates the selected SQL connection and pins the database identity before writing canonical local configuration. An empty database requires explicit initialization authorization; an existing database may require a separately authorized schema migration. See the [configuration contract](contracts/v1/README.md#local-config) for credential sources and safety rules.

Keep credentials outside the repository. Do not reuse production credentials for development or CI. A GitHub checkout and a SQL ledger are separate resources: copying code is not a database migration.

## Start a workflow

Use `grounds help --json` for the installed command surface and the [workflow skill](../plugins/grounds/skills/grounds/SKILL.md) for the supported requirement → candidate → independent verification → delivery workflow. The [contracts](contracts/v1/README.md) define structured inputs and outputs. Candidate submission also checks archive protection on the target host; a repository plan without those protections cannot satisfy that requirement.

To inspect the terminal interface after building both components, run `grounds-tui --help`. Configure a ledger before opening data-backed views.
