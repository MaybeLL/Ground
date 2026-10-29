import { chmodSync, copyFileSync } from "node:fs";
chmodSync(new URL("../dist/bin.js", import.meta.url), 0o755);

for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) copyFileSync(new URL(`../../${name}`, import.meta.url), new URL(`../dist/${name}`, import.meta.url));
