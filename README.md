# Grounds

Grounds records requirements, candidate changes, verification evidence, and delivery decisions for work shared by people and coding agents. It provides a TypeScript CLI and an agent workflow skill.

**Release status:** Grounds is a pre-1.0 project; commands and contracts may evolve. The project is licensed under [MIT](LICENSE); bundled third-party components retain their own licenses. See the [release process](docs/releases.md) for validation, npm publication setup and GitHub release downloads.

The canonical source and automation are hosted at [MaybeLL/Ground on GitHub](https://github.com/MaybeLL/Ground). Development and releases use GitHub Actions; no GitLab mirror or GitLab runner is required.

## How it works

Define a task and its acceptance criteria, then start a work. The worker delivers an immutable Git commit through a remote tag. Grounds checks the remote tag before recording delivery. A fresh evaluator grades the frozen commit against its task revision. A rejected delivery can be refined in a new worktree. The work records which run is current and its final acceptance outcome.

## Install a published version

Public npm packages are available beginning with version `0.2.52`. Install the CLI (published versions predate the source cutover described above):

```sh
npm install -g @maybell/grounds@0.2.53
grounds --help
```

Use Node.js 22.13 or later. Published releases through 0.2.53 may require Python 3 and a C/C++ build toolchain (Xcode Command Line Tools on macOS, or make and a C/C++ compiler on Linux). The same installation artifacts are also available as [GitHub release tarballs](docs/releases.md#install-a-github-release). Stateful workflows require a configured SQL ledger; see the [getting started guide](docs/getting-started.md).

The refactor build bundles native support for macOS and glibc Linux on x64 and arm64. Its staged tarball can be installed with `npm install -g /path/to/package.tgz`.

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
2. Explore the installed command surface with `grounds help --json`. Use the [workflow skill](plugins/grounds/skills/grounds/SKILL.md) to navigate a task through development, verification, review, and delivery.

For release packages, see [installation from a GitHub release](docs/releases.md#install-a-github-release). When upgrading to 0.2.50, saved older pagination cursors must be restarted and existing selection snapshots may require review; see the [upgrade notes](docs/releases.md#release-gates).

## Learn and contribute

- [Documentation and architecture](docs/README.md)
- [Contributing and testing](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)
- [Release process](docs/releases.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

The CI matrix targets Linux/macOS with Node.js 22/24; Windows is unverified. It checks SQLite local ledgers and MySQL/PostgreSQL TLS integration. Consult the actual GitHub run for the commit before relying on a platform result.

The CLI and bundled plugin are versioned together. Generic regression tests ship with the source; private evaluation cases and one-off acceptance materials are not part of the community repository. Optional integrations require their own configuration and credentials.
