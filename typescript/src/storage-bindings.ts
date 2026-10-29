import { existsSync } from "node:fs";
import { sep } from "node:path";
import { execFileSync } from "node:child_process";
import { validation } from "./errors.js";
import type { RuntimeRecord } from "./runtime-record.js";
import type { DataMigrationPlan } from "./data-migration-plan.js";
import type { Store } from "./store-types.js";
import { digestBytes, safeRead } from "./runtime-files.js";

export interface PathMapping { source: string; target: string }
export const RELOCATABLE_RUNTIME_FORMATS = ["grounds.code-workspace-instance/v1", "grounds.code-workspace-route/v1",
  "grounds.development-image-preparation/v1", "grounds.repository-image-preparation/v1"];
export function relocatePath(path: string, mappings: PathMapping[]): string {
  const owner = mappings.filter(item => path === item.source || path.startsWith(item.source + sep)).sort((a,b) => b.source.length-a.source.length)[0];
  return owner ? owner.target + path.slice(owner.source.length) : path;
}

/** Only host routing records are mutable. Ledger events, Candidates, signed reports and operation receipts are never rewritten. */
export function relocateRuntimeRecord(row: RuntimeRecord, mappings: PathMapping[]): RuntimeRecord | undefined {
  const data = structuredClone(row.data);
  if (data.format === "grounds.code-workspace-instance/v1") {
    if (typeof data.data_root !== "string") return undefined;
    data.data_root = relocatePath(data.data_root, mappings);
    if (!Array.isArray(data.baselines)) throw validation("migration", "invalid workspace baselines");
    data.baselines = data.baselines.map((baseline: any) => ({ ...baseline, path: relocatePath(baseline.path, mappings) }));
  } else if (data.format === "grounds.code-workspace-route/v1") {
    if (typeof data.path !== "string") throw validation("migration", "invalid route path");
    data.path = relocatePath(data.path, mappings);
  } else if (["grounds.development-image-preparation/v1", "grounds.repository-image-preparation/v1"].includes(String(data.format))) {
    if (typeof data.data_root !== "string") throw validation("migration", "invalid preparation data root");
    const root = relocatePath(data.data_root, mappings);
    if (root === data.data_root) return undefined;
    if (!["ready", "cancelled", "failed"].includes(String(data.state)) || (data.cleanup as { state?: string } | undefined)?.state === "pending")
      throw validation("migration", "finish, cancel or recover the image preparation before migration");
    data.data_root = root;
  } else return undefined;
  if (JSON.stringify(data) === JSON.stringify(row.data)) return undefined;
  return { ...row, version: row.version + 1, data };
}

/** Live filesystem bindings have an explicit allowlist; historical evidence is not text-replaced. */
export function relocateLocalBinding(value: Record<string, unknown>, mappings: PathMapping[]): Record<string, unknown> | undefined {
  const data = structuredClone(value);
  const remapFields = (fields: string[]): Record<string, unknown> | undefined => {
    for (const name of fields) {
      if (typeof data[name] !== "string") throw validation("migration", `invalid live ${name} binding`);
      data[name] = relocatePath(data[name] as string, mappings);
    }
    return JSON.stringify(data) === JSON.stringify(value) ? undefined : data;
  };
  let field: string;
  switch (data.format) {
    case "grounds.environment/v1":
      if (data.state !== "released" || (data.cleanup as { state?: string } | undefined)?.state !== "complete")
        throw validation("migration", "finalize the environment and its cleanup before migration");
      return remapFields(["directory", "workspace", "original_workspace"]);
    case "grounds.environment-run/v1":
      if (data.state === "running" || data.termination !== "confirmed" || data.cleanup !== "complete")
        throw validation("migration", "confirm environment command termination and cleanup before migration");
      return remapFields(["directory"]);
    case "grounds.code-route-execution/v1":
      if (data.state !== "stopped") throw validation("migration", "stop the route execution before migration");
      if (data.baselines !== undefined) {
        if (!Array.isArray(data.baselines)) throw validation("migration", "invalid execution baselines");
        data.baselines = data.baselines.map((baseline: any) => ({ ...baseline, path: relocatePath(baseline.path, mappings) }));
      }
      return remapFields(["code_path"]);
    case "grounds.code-route-fence/v1": {
      const control = data.control as { execution_id?: string } | undefined;
      if (control?.execution_id) throw validation("migration", "route execution still owns its fence; stop and reconcile before migration");
      field = "path"; break;
    }
    case "grounds.development-branch/v1":
      // A nested branch identity has no local path and needs no migration.
      if (data.path === undefined) return undefined;
      field = "path"; break;
    case "patchledger.local-dev-worktree/v3":
    case "grounds.local-development-worktree/v1":
      if (["syncing", "sync_interrupted"].includes(String(data.lifecycle))) throw validation("migration", "finish or recover the pending development sync before migration");
      if (data.external_input && typeof data.worktree_path === "string" && relocatePath(data.worktree_path, mappings) !== data.worktree_path)
        throw validation("migration", "external workspace identity cannot be reassigned by data migration");
      field = "worktree_path"; break;
    case "patchledger.local-delivery/v1":
      if (data.stage !== "complete") throw validation("migration", "finish the pending delivery before migration");
      field = "target_path"; break;
    default: return undefined;
  }
  if (typeof data[field] !== "string") throw validation("migration", "invalid live local path binding");
  data[field] = relocatePath(data[field] as string, mappings);
  return JSON.stringify(data) === JSON.stringify(value) ? undefined : data;
}

/** Expected versions prevent migration overwriting another coordinator's work. */
export async function saveRelocatedRuntimeRecords(store: Store, originals: RuntimeRecord[], mappings: PathMapping[]): Promise<void> {
  await store.write(async tx => {
    for (const original of originals) {
      const updated = relocateRuntimeRecord(original, mappings);
      if (!updated) continue;
      await tx.lockRuntimeRecord(original.kind, original.id);
      const current = await tx.getRuntimeRecord(original.kind, original.id);
      if (current && current.version === updated.version && JSON.stringify(current.data) === JSON.stringify(updated.data)) continue;
      if (!current || current.version !== original.version || JSON.stringify(current.data) !== JSON.stringify(original.data)) throw validation("migration", "workspace routing changed; retain migration journal and reconcile before continuing");
      await tx.saveRuntimeRecord(updated, original.version);
    }
  });
}

export function repairRelocatedWorktrees(plan: DataMigrationPlan, mappings: PathMapping[]): void {
  const groups = new Map<string, string[]>();
  for (const worktree of plan.worktrees) {
    const common = relocatePath(worktree.common, mappings);
    const paths = groups.get(common) ?? []; paths.push(worktree.target); groups.set(common, paths);
  }
  for (const [common, paths] of groups) {
    if (!existsSync(common)) throw validation("migration", "Git common directory is missing after relocation");
    execFileSync("git", ["--git-dir", common, "worktree", "repair", ...paths], { stdio: ["ignore", "pipe", "pipe"] });
  }
  for (const worktree of plan.worktrees) {
    const git = (args: string[]) => execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd: worktree.target, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
    if (git(["rev-parse", "HEAD"]) !== worktree.head || git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]) !== worktree.status)
      throw validation("migration", "Git state differs after relocation; retain both copies for recovery");
    if (git(["rev-parse", "--path-format=absolute", "--git-common-dir"]) !== relocatePath(worktree.common, mappings))
      throw validation("migration", "Git worktree belongs to the wrong object store after relocation");
    if (worktree.index_digest !== undefined) {
      const index = git(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
      if ((existsSync(index) ? digestBytes(safeRead(index)) : "absent") !== worktree.index_digest)
        throw validation("migration", "Git index bytes differ after relocation; retain recovery material");
    }
  }
}
