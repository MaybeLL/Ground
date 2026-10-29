import { closeSync, constants, existsSync, lstatSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { validation } from "./errors.js";
import { directoryRegistryRoot, safeRead, withRuntimeLock } from "./runtime-files.js";

/** Hold the previous version's known controller locks as well as the new layout lock. */
export async function withPreviousLayoutIdle<T>(input: {
  oldData: string; oldRuntime: string; oldRegistry: string; repositories: string[];
  retiredControllers?: ReadonlyMap<string, string>;
}, work: () => Promise<T>): Promise<T> {
  const perform = async (): Promise<T> => {
    const { flock } = await import("fs-ext");
    const handles: number[] = [];
    const registryMutex = join(input.oldRegistry, "locks", createHash("sha256").update("directory-registry").digest("hex") + ".lock");
    const files = new Set<string>();
    for (const root of [join(input.oldData, "runtime", "locks"), join(input.oldRuntime, "locks"),
      join(input.oldRuntime, "environments", "locks"), join(input.oldRegistry, "locks")]) {
      if (!existsSync(root)) continue;
      if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw validation("migration", "invalid previous lock directory");
      for (const name of readdirSync(root)) if (name.endsWith(".lock")) files.add(join(root, name));
    }
    files.delete(registryMutex);
    files.delete(join(directoryRegistryRoot(), "locks", createHash("sha256").update("data-layout").digest("hex") + ".lock"));
    const instances = join(input.oldRuntime, "environments", "instances");
    if (existsSync(instances)) for (const name of readdirSync(instances)) {
      const path = join(instances, name, "operation.lock");
      if (existsSync(path)) files.add(path);
    }
    requireIdleRepositoryControllers(input.repositories, input.retiredControllers);
    try {
      for (const path of [...files].sort()) {
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw validation("migration", "invalid previous controller lock file");
        const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
        handles.push(fd);
        try { await new Promise<void>((yes, no) => flock(fd, "exnb", error => error ? no(error) : yes())); }
        catch { throw validation("migration", "a previous-version controller is still using the data; stop it before migration"); }
      }
      return await work();
    } finally { for (const fd of handles.reverse()) closeSync(fd); }
  };
  return existsSync(input.oldRegistry) ? withRuntimeLock(input.oldRegistry, "directory-registry", perform) : perform();
}

export function requireIdleRepositoryControllers(repositories: string[], retiredControllers?: ReadonlyMap<string, string>): void {
  for (const repository of repositories) {
    const root = join(repository, ".grounds", "devruns", ".locks");
    if (!existsSync(root)) continue;
    const stat = lstatSync(root);
    const marker = retiredControllers?.get(root);
    if (marker !== undefined && stat.isFile() && !stat.isSymbolicLink() && safeRead(root, 64 * 1024).toString() === marker) continue;
    if (stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(root).length)
      throw validation("migration", "development controller lock needs reconciliation before migration");
  }
}
