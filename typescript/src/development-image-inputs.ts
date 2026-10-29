import { existsSync, readdirSync, rmdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import type { DevelopmentRecipe } from "./development-recipes.js";
import { digestBytes, privateDirectory, safeRead, removePrivateFile } from "./runtime-files.js";
import { DomainError } from "./errors.js";

/** The whole selected context is validated before dispatch or before its first deletion. */
export function inspectDevelopmentInputs(context: string, recipe: DevelopmentRecipe, allowMissing = false): { files: string[]; directories: string[] } {
  const fail = (): never => { throw new DomainError("STATE_CONFLICT", "Build context contains unexpected, missing or modified inputs"); };
  if (!existsSync(context)) { if (allowMissing) return { files: [], directories: [] }; return fail(); }
  privateDirectory(context);
  const expected = new Map(recipe.files.map(file => [file.path, file]));
  const allowedDirectories = new Set<string>();
  for (const path of expected.keys()) { const parts = path.split("/"); for (let n = 1; n < parts.length; n++) allowedDirectories.add(parts.slice(0, n).join("/")); }
  const files: string[] = [], directories: string[] = []; let count = 0;
  const visit = (relative: string) => {
    for (const entry of readdirSync(join(context, relative), { withFileTypes: true })) {
      if (++count > 512) fail();
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory() && allowedDirectories.has(path)) { privateDirectory(join(context, path)); visit(path); directories.push(path); continue; }
      const selected = expected.get(path), stat = lstatSync(join(context, path));
      if (!entry.isFile() || !selected || stat.nlink !== 1 || (stat.mode & 0o777) !== (selected.mode === "100755" ? 0o755 : 0o644)
        || digestBytes(safeRead(join(context, path), 4 * 1024 * 1024)) !== selected.digest) fail();
      expected.delete(path); files.push(path);
    }
  };
  visit(""); if (!allowMissing && expected.size) fail();
  return { files, directories };
}
export function cleanupDevelopmentInputs(context: string, recipe: DevelopmentRecipe) {
  const snapshot = inspectDevelopmentInputs(context, recipe, true);
  for (const file of snapshot.files) removePrivateFile(join(context, file));
  for (const directory of snapshot.directories) rmdirSync(join(context, directory));
  if (existsSync(context)) rmdirSync(context);
}
