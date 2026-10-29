# Grounds

Grounds records requirements, candidate changes, verification evidence, and delivery decisions for work shared by people and coding agents. It provides a TypeScript CLI, a terminal review interface, and agent workflow skills.

**Release status:** Grounds is preparing its first GitHub release. The project is licensed under [MIT](LICENSE); bundled third-party components retain their own licenses. See the [release process](docs/releases.md) for validation and distribution details. There is no public npm installation channel.

The canonical source and automation are hosted at [MaybeLL/grounds-open on GitHub](https://github.com/MaybeLL/grounds-open). Development and releases use GitHub Actions; no GitLab mirror or GitLab runner is required.

## Build from source

Use Node.js 22.13 or later, npm, Git, Python 3, and a C/C++ build toolchain. Native dependencies require build tools (Xcode Command Line Tools on macOS, or make and a C/C++ compiler on Linux).

```sh
git clone https://github.com/MaybeLL/grounds-open.git
cd grounds-open
(cd typescript && npm ci && npm run build)
(cd tui && npm ci && npm run build)
node typescript/dist/src/bin.js help --json
```

Repository access is required while it remains private. Building and showing help do not require a database or Git hosting credentials. Stateful workflows require a configured SQL ledger; see the [getting started guide](docs/getting-started.md).

## Learn and contribute

- [Documentation and architecture](docs/README.md)
- [Contributing and testing](CONTRIBUTING.md)
- [Security reporting](SECURITY.md)
- [Release process](docs/releases.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

The CI matrix targets Linux/macOS with Node.js 22/24 and is undergoing initial validation; Windows is unverified. SQLite local ledgers and MySQL/PostgreSQL TLS integration checks are included in the validation plan. Consult the actual GitHub run for the commit before relying on a platform result.

The CLI and TUI are versioned together. Generic regression tests ship with the source; private evaluation cases and one-off acceptance materials are not part of the community repository. Optional integrations require their own configuration and credentials.
