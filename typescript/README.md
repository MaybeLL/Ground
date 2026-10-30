# Grounds CLI

Grounds records requirements, candidate changes, verification evidence, and delivery decisions for people and coding agents. The CLI and terminal UI use matching versions.

See the [documentation](https://github.com/MaybeLL/grounds-open/blob/main/docs/README.md), [source build instructions](https://github.com/MaybeLL/grounds-open/blob/main/README.md#build-from-source), and [release guide](https://github.com/MaybeLL/grounds-open/blob/main/docs/releases.md). Node.js 22.13 or later is required.

For versions published on npm, install the CLI and matching TUI with `npm install -g @maybell/grounds@X.Y.Z @maybell/grounds-tui@X.Y.Z`, replacing `X.Y.Z` with a published version. Native dependencies may require Python 3 and C/C++ build tools. Run `grounds --help` to verify installation.

From this source directory, run `npm ci` and `npm run build`. Approved GitHub Release tarballs are also available through the release guide. Grounds is licensed under MIT; third-party dependencies retain their licenses.
