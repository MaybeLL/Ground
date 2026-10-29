import { lstatSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { DomainError } from "./errors.js";
import { buildRecipe, type RepositoryBuildMaterial } from "./repository-build-materials.js";
import type { ImagePreparation } from "./repository-image-preparation.js";
import { digestBytes, privateDirectory, removePrivateFile, safeRead } from "./runtime-files.js";

/** Retain unique logs/proofs and Docker images. Only exact, reproducible bytes are removable. */
export function cleanupBuildInputs(record: ImagePreparation, material: RepositoryBuildMaterial): void {
  const root = join(record.data_root, "runtime", "image-preparations", record.preparation_id);
  try { lstatSync(root); } catch (error: any) { if (error.code === "ENOENT") return; throw error; }
  privateDirectory(root);
  const expected = new Map(material.files.map(file => [`context/${file.path}`, file.digest]));
  const recipe = digestBytes(Buffer.from(buildRecipe(material, `grounds-build-base:${record.preparation_id}`)));
  expected.set("Dockerfile", recipe); expected.set(".grounds-build-recipe", recipe);
  expected.set(".dockerignore", digestBytes(Buffer.from(".grounds-build-recipe\n.dockerignore\n")));
  if (record.image) expected.set("image-id", digestBytes(Buffer.from(record.image)));
  const directories = new Set<string>(["context"]);
  for (const path of expected.keys()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  const files: string[] = [], emptyDirectories: string[] = [];
  let count = 0;
  const inspect = (relative: string) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (++count > 512) throw new DomainError("STATE_CONFLICT", "Build cleanup found too many entries");
      if (entry.isDirectory() && directories.has(path)) {
        privateDirectory(join(root, path)); inspect(path); emptyDirectories.push(path); continue;
      }
      if (!entry.isFile()) throw new DomainError("STATE_CONFLICT", "Build cleanup found an unexpected entry or link");
      if (["build.log", "build-failure.json"].includes(path)) continue;
      const digest = expected.get(path);
      if (!digest || digestBytes(safeRead(join(root, path), 4 * 1024 * 1024)) !== digest)
        throw new DomainError("STATE_CONFLICT", "Build cleanup found unexpected or modified files; retain inputs");
      files.push(path);
    }
  };
  inspect(""); // Validate the whole directory before the first deletion.
  for (const path of files) removePrivateFile(join(root, path));
  for (const path of emptyDirectories) rmdirSync(join(root, path));
}
