import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleSkillAssets, skillNames } from "../dist/src/skill-assets.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageRoot, "../plugins/grounds");
const target = resolve(packageRoot, "dist/assets/grounds");
rmSync(target, { recursive: true, force: true });
mkdirSync(resolve(target, "skills"), { recursive: true });
for (const name of skillNames) assembleSkillAssets(source, name, resolve(target, "skills", name));
chmodSync(resolve(packageRoot, "dist/src/bin.js"), 0o755);
copyFileSync(resolve(packageRoot, "assets/code-route-client.py"), resolve(packageRoot, "dist/assets/code-route-client.py"));
