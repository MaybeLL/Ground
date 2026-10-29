# Third-party notices

Grounds project code is distributed under the [MIT license](LICENSE). Third-party components retain their own licenses and copyright notices.

The CLI includes the unmodified Mermaid 12.2.0 browser bundle. Its [component notices](typescript/vendor/THIRD-PARTY-NOTICES.md), [Mermaid license](typescript/vendor/MERMAID-LICENSE), exact [component inventory](typescript/vendor/mermaid-components.json), and verbatim component license files accompany the vendored bundle. The inventory was derived from the official bundle source map and matching upstream release tag; each license file was obtained from the identified component's official npm tarball. The bundle's SHA-256 is recorded alongside the inventory.

The included elkjs/Eclipse ELK component is available as Source Code under EPL-2.0. Its exact upstream source revisions, download links, and build instructions accompany the CLI at `vendor/licenses/elkjs@0.9.3__SOURCE.md`. Preserve this source-availability notice and its EPL license when redistributing.

DOMPurify is redistributed under the Apache-2.0 option of its dual license. Preserve supplied license texts and embedded copyright comments when redistributing the browser bundle. Other runtime dependencies are installed from the npm lockfiles and carry their own licenses. Review dependency and notice changes together when upgrading packages.

In packaged CLI distributions, the component notices and licenses are under `vendor/`. This root notice and the Grounds license are included in each package's `dist/` directory.
