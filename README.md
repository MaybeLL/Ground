# Grounds

Grounds records requirements, candidate changes, verification evidence, and delivery decisions for work shared by people and coding agents. It provides a TypeScript CLI and an agent workflow skill.

**Release status:** Grounds is a pre-1.0 project; commands and contracts may evolve. The project is licensed under [MIT](LICENSE); bundled third-party components retain their own licenses. See the [release process](docs/releases.md) for validation, npm publication setup and GitHub release downloads.

The canonical source and automation are hosted at [MaybeLL/Ground on GitHub](https://github.com/MaybeLL/Ground). Development and releases use GitHub Actions; no GitLab mirror or GitLab runner is required.

## How it works

A Task defines the acceptance criteria. A worker freezes its delivery, an independent evaluator grades it, and a person selects the outcome and closes the work.

- The **CLI** records task revisions, work runs, frozen deliveries and independent grades.
- The **development skill** guides the new `task / work / grade` loop, including a fresh independent evaluator. Start with the [Grounds workflow skill](plugins/grounds/skills/grounds/SKILL.md).

**Source cutover status:** Legacy draft publication, contract editing and static rendering have been retired. Candidate selection, completion recording and delivery preparation have also been retired. Use `grounds work select` and `grounds work close` for everyday work. For new contracts, use `grounds task create`. The legacy `eval` CLI, QA authoring/capture workflow, evaluation TUI and evaluation/knowledge skills have been removed under D149. The remaining legacy Candidate TUI package has also been retired, including its build and release entries. A new work-model TUI is not implemented; use the CLI and development skill. The old `code-workspace` container routes, repository environment defaults, image preparation and service/volume cleanup commands have also been retired; standalone `env` remains. New evaluation assets and managed experiments remain planned for P3–P5. This source-tree status does not change previously published npm packages.

Candidate Git artifacts are archived remotely under protected namespaces. GitHub and GitLab repositories can be onboarded; archive protection and authorization must be verifiable when a candidate is submitted.

## Install a published version

Public npm packages are available beginning with version `0.2.52`. Install the CLI (published versions predate the source cutover described above):

```sh
npm install -g @maybell/grounds@0.2.53
grounds --help
```

Use Node.js 22.13 or later. The CLI's native dependencies may require Python 3 and a C/C++ build toolchain (Xcode Command Line Tools on macOS, or make and a C/C++ compiler on Linux). The same installation artifacts are also available as [GitHub release tarballs](docs/releases.md#install-a-github-release). Stateful workflows require a configured SQL ledger; see the [getting started guide](docs/getting-started.md).

## Build from source

Use Node.js 22.13 or later, npm, Git, Python 3, and a C/C++ build toolchain. Native dependencies require build tools (Xcode Command Line Tools on macOS, or make and a C/C++ compiler on Linux).

```sh
git clone https://github.com/MaybeLL/Ground.git
cd Ground
(cd typescript && npm ci && npm run build)
node typescript/dist/src/bin.js help --json
```

Building and showing help do not require a database or Git hosting credentials. Stateful workflows require a configured SQL ledger; see the [getting started guide](docs/getting-started.md).

## Get started

1. Follow the [getting started guide](docs/getting-started.md) to link the CLI locally and configure a SQLite, MySQL, or PostgreSQL ledger. Run `grounds init --help` before initialization; keep credentials outside the repository.
2. For GitHub candidate archives, follow [GitHub archive onboarding](plugins/grounds/skills/grounds/references/github-archive-onboarding.md) to configure authentication, protected namespaces, and the repository binding. GitLab users can follow the [GitLab guide](plugins/grounds/skills/grounds/references/gitlab-archive-onboarding.md).
3. Explore the installed command surface with `grounds help --json`. Use the [workflow skill](plugins/grounds/skills/grounds/SKILL.md) to navigate a requirement through development, verification, review, and delivery.

For release packages, see [installation from a GitHub release](docs/releases.md#install-a-github-release). When upgrading to 0.2.50, saved older pagination cursors must be restarted and existing selection snapshots may require review; see the [upgrade notes](docs/releases.md#release-gates).

## Learn and contribute

- [Documentation and architecture](docs/README.md)
- [Contributing and testing](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)
- [Release process](docs/releases.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

The CI matrix targets Linux/macOS with Node.js 22/24; Windows is unverified. It checks SQLite local ledgers and MySQL/PostgreSQL TLS integration. Consult the actual GitHub run for the commit before relying on a platform result.

The CLI and bundled plugin are versioned together. Generic regression tests ship with the source; private evaluation cases and one-off acceptance materials are not part of the community repository. Optional integrations require their own configuration and credentials.
