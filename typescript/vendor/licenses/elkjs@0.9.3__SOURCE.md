# elkjs 0.9.3 source availability

The elkjs / Eclipse ELK portions of the bundled renderer are available as Source Code under the Eclipse Public License 2.0. A complete copy of that license accompanies this notice in `elkjs@0.9.3__LICENSE.md`. The Grounds MIT license does not replace the EPL terms for these components.

Obtain the upstream source and build instructions from:

- elkjs 0.9.3 source tag: https://github.com/kieler/elkjs/tree/0.9.3
- Fixed elkjs source commit: https://github.com/kieler/elkjs/tree/a8304cf79fde75bc2ab1a89d28320f53f8637436
- Downloadable source archive: https://github.com/kieler/elkjs/archive/a8304cf79fde75bc2ab1a89d28320f53f8637436.tar.gz
- Build instructions: https://github.com/kieler/elkjs/blob/a8304cf79fde75bc2ab1a89d28320f53f8637436/README.md#building

The npm 0.9.3 manifest's gitHead and the upstream 0.9.3 tag both identify that elkjs commit. The upstream release notes explicitly state that this release uses ELK 0.9.1 plus the port-placement fix in ELK pull request 955:

- Release notes: https://github.com/kieler/elkjs/releases/tag/0.9.3
- ELK v0.9.1 source: https://github.com/eclipse-elk/elk/tree/62d5909f96fad541bc101ad52dabaece6b7eab7e
- ELK source download: https://github.com/eclipse-elk/elk/archive/62d5909f96fad541bc101ad52dabaece6b7eab7e.tar.gz
- Additional upstream fix: https://github.com/eclipse-elk/elk/pull/955
- Fix merge commit: https://github.com/eclipse-elk/elk/commit/7ca51784e42a24201f29bc13e458728b6fc61cdc

Use the upstream build instructions, ELK source, and documented additional fix when inspecting or rebuilding this component. Grounds distributes the official Mermaid browser bundle unchanged; it does not independently modify elkjs/ELK. Retain these source-availability directions, the EPL license, and upstream attribution notices when redistributing these components. These references describe the upstream-published provenance; Grounds has not independently reproduced the upstream GWT build byte for byte.
