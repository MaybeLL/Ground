# Contributing

Development happens at [MaybeLL/grounds-open](https://github.com/MaybeLL/grounds-open). Use GitHub issues for reproducible bugs and scoped proposals, and pull requests for code or documentation changes. Project contributions are made under the [MIT license](LICENSE). Third-party code must retain its applicable notices and license terms.

## Local checks

Build the CLI before TUI integration or plugin end-to-end checks. Use Node.js 22.13 or later and Python 3:

```sh
(cd typescript && npm ci && npm run build && npm test)
(cd tui && npm ci && npm run build && npm test)
python3 -m unittest discover -s plugins/grounds/tests -p 'test_*.py' -q
node --test scripts/*.test.mjs
node scripts/check-docs.mjs
```

Database, container, PTY, and scale tests have additional prerequisites and must be explicitly configured. A skipped integration test is not evidence that its behavior passed. The GitHub workflows define the checks run on each pull request and release. The validation matrix targets Linux/macOS on Node.js 22/24, with an additional Linux integration job covering SQLite plus MySQL/PostgreSQL over TLS, TUI scale, and PTY behavior. Consult the actual run for the commit instead of treating workflow configuration as a passing result. Windows is not validated.

Use focused regression tests for behavior changes. Keep TypeScript indentation at two spaces and preserve ESM imports. Do not edit generated `dist/` contents. Update command help, contracts, and guides when changing user-visible behavior.

Follow the [software design principles](docs/software-design.md) for substantive design changes and the [documentation maintenance rules](docs/documentation.md) when assessing documentation impact.

## Pull requests

Explain the problem, resulting behavior, and validation performed. Disclose schema or configuration changes and any tests that were skipped. Use a focused Conventional Commit title such as `fix(cli): validate archive permissions`. Do not include credentials, personal paths, company data, or private acceptance materials in fixtures or logs. Confirm that you have permission to contribute the submitted material.

Follow [repository guidance](AGENTS.md). Maintainers keep local progress records outside this repository; contributor-facing decisions belong in issues, pull requests, and documentation.
