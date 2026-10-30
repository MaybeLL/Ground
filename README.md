# Grounds

Grounds records requirements, candidate changes, verification evidence, and delivery decisions for work shared by people and coding agents. It provides a TypeScript CLI, a terminal review interface, and agent workflow skills.

**Release status:** Grounds is a pre-1.0 project; commands and contracts may evolve. The project is licensed under [MIT](LICENSE); bundled third-party components retain their own licenses. See the [release process](docs/releases.md) for validation, npm publication setup and GitHub release downloads.

The canonical source and automation are hosted at [MaybeLL/Ground on GitHub](https://github.com/MaybeLL/Ground). Development and releases use GitHub Actions; no GitLab mirror or GitLab runner is required.

## How it works

Grounds keeps a record of the path from a requirement to delivery: an issue version defines the work, a development run produces an immutable candidate, and independent verification records evidence for review. A person can then select a candidate and prepare it for delivery. A recorded claim, a verification result, and an actual delivery are distinct events.

- The **CLI** manages the SQL ledger, development runs, candidates, verification, and delivery records.
- The **TUI** provides a terminal workspace for reviewing candidates and their evidence.
- The **agent skills** guide development and delivery, evaluation, and documentation improvement workflows. Start with the [Grounds workflow skill](plugins/grounds/skills/grounds/SKILL.md).

Candidate Git artifacts are archived remotely under protected namespaces. GitHub and GitLab repositories can be onboarded; archive protection and authorization must be verifiable when a candidate is submitted.

## Install a published version

Public npm packages are available beginning with version `0.2.52`. Install matching CLI and TUI versions:

```sh
npm install -g @maybell/grounds@0.2.53 @maybell/grounds-tui@0.2.53
grounds --help
grounds-tui --help
```

Use Node.js 22.13 or later. The CLI's native dependencies may require Python 3 and a C/C++ build toolchain (Xcode Command Line Tools on macOS, or make and a C/C++ compiler on Linux). The same installation artifacts are also available as [GitHub release tarballs](docs/releases.md#install-a-github-release). Stateful workflows require a configured SQL ledger; see the [getting started guide](docs/getting-started.md).

## Build from source

Use Node.js 22.13 or later, npm, Git, Python 3, and a C/C++ build toolchain. Native dependencies require build tools (Xcode Command Line Tools on macOS, or make and a C/C++ compiler on Linux).

```sh
git clone https://github.com/MaybeLL/Ground.git
cd Ground
(cd typescript && npm ci && npm run build)
(cd tui && npm ci && npm run build)
node typescript/dist/src/bin.js help --json
```

Building and showing help do not require a database or Git hosting credentials. Stateful workflows require a configured SQL ledger; see the [getting started guide](docs/getting-started.md).

## Get started

1. Follow the [getting started guide](docs/getting-started.md) to link the CLI and TUI locally and configure a SQLite, MySQL, or PostgreSQL ledger. Run `grounds init --help` before initialization; keep credentials outside the repository.
2. For GitHub candidate archives, follow [GitHub archive onboarding](plugins/grounds/skills/grounds/references/github-archive-onboarding.md) to configure authentication, protected namespaces, and the repository binding. GitLab users can follow the [GitLab guide](plugins/grounds/skills/grounds/references/gitlab-archive-onboarding.md).
3. Explore the installed command surface with `grounds help --json`, or run `grounds-tui --help` to inspect the terminal interface. Use the [workflow skill](plugins/grounds/skills/grounds/SKILL.md) to navigate a requirement through development, verification, review, and delivery.

For release packages, see [installation from a GitHub release](docs/releases.md#install-a-github-release). CLI and TUI versions must match. When upgrading to 0.2.50, saved older pagination cursors must be restarted and existing selection snapshots may require review; see the [upgrade notes](docs/releases.md#release-gates).

## Learn and contribute

- [Documentation and architecture](docs/README.md)
- [Contributing and testing](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)
- [Release process](docs/releases.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

The CI matrix targets Linux/macOS with Node.js 22/24; Windows is unverified. It checks SQLite local ledgers and MySQL/PostgreSQL TLS integration. Consult the actual GitHub run for the commit before relying on a platform result.

The CLI and TUI are versioned together. Generic regression tests ship with the source; private evaluation cases and one-off acceptance materials are not part of the community repository. Optional integrations require their own configuration and credentials.
