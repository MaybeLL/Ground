import { safeRead } from "./runtime-files.js";
import { validateVolumeChecks } from "./code-route-volume-restore.js";
import { resolve } from "node:path";
import type { ParsedArgs } from "./cli.js";
import type { Attribution } from "./domain.js";
import type { Store } from "./store-types.js";
import { validation } from "./errors.js";
import { CodeRouteServiceCleanup } from "./code-route-service-cleanup.js";
import { CodeWorkspaces } from "./code-workspace.js";
import { CodeWorkspaceCleanup } from "./code-workspace-cleanup.js";
import { archivePolicyFor } from "./repository-archive-cli.js";

export const codeCleanupCommands = {
  "service-volume-delete": { options: ["config", "execution-id", "archive-id", "expected-version", "early", "operation-id", "agent-id", "agent-name"],
    description: "Revalidate a fixed evidence chain, freshly archive current contents, persist deletion intent and remove the exact retired unused volume without force; retain archives/images; resume original ID, completed replay is historical" },
  "service-volume-assess": { options: ["config", "execution-id", "archive-id", "early"],
    description: "Read and verify an explicit retirement/capture/checked-restore/recheck evidence chain and current source identity; no new capture, no deletion authorization; early bypasses retention time only" },
  "service-volume-restoration-cleanup": { options: ["config", "execution-id", "restore-id", "early", "expected-version", "operation-id", "agent-id", "agent-name"],
    description: "Archive available logs and remove an exact stopped completed restoration container after persistent retirement; refuse unpreserved filesystem changes, honor lifecycle/pin, retain volume; resume with original operation ID" },
  "service-volume-retire": { options: ["config", "execution-id", "restore-id", "operation-id", "agent-id", "agent-name"],
    description: "Persistently block Grounds-managed writes to a stopped source or completed restore volume; keep data and read/export access; original-ID replay is historical; no unretire or deletion" },
  "service-volume-preview": { options: ["config", "execution-id"],
    description: "Read retained source/restore volumes, current archive integrity and protection blockers for an ended execution; no resource mutations or deletion authorization" },
  "service-volume-restoration-stop": { options: ["config", "execution-id", "restore-id", "operation-id", "agent-id", "agent-name"],
    description: "Halt an incomplete restoration after proving its owned container stopped; retain volumes, prevent resume; original-ID replay is historical" },
  "service-volume-restore": { options: ["config", "execution-id", "archive-id", "checks-file", "operation-id", "agent-id", "agent-name"],
    description: "Restore a registered archive into a new private volume, check PostgreSQL startup/catalogs and optional --checks-file table row counts, then stop it; retain source and target; unknown imports are never overlaid" },
  "service-volume-restoration-show": { options: ["config", "execution-id", "restore-id"],
    description: "Read historical restoration evidence and persisted attempt phase; pending is not a background task or live-health claim" },
  "service-volume-export": { options: ["config", "execution-id", "restore-id", "compare-archive-id", "verified-restore-id", "operation-id", "agent-id", "agent-name"],
    description: "Export a retained volume after service cleanup into a bounded cold tar archive; retain source, revalidate bytes on original-ID replay; restore is not yet verified; optional --restore-id selects a completed, currently stopped restoration volume; optional --compare-archive-id compares the new tar bytes with a fixed intact archive; original-ID replay is historical; --verified-restore-id binds passing checks for the exact comparison archive before capture" },
  "service-cleanup-preview": { options: ["config", "execution-id", "early"],
    description: "Inspect ROUTE --execution-id ID stopped service resources of an ended Workspace; honor retention/pin, retain volume and images; preview is not deletion approval" },
  "service-cleanup": { options: ["config", "execution-id", "early", "expected-version", "plan-digest", "operation-id", "agent-id", "agent-name"],
    description: "Recheck a service preview, archive logs, remove only owned stopped container and unused network; preserve data volume/images; resume with the original operation ID" },
  end: { options: ["config", "data-root", "expected-version", "retention-days", "pinned", "operation-id", "agent-id", "agent-name"],
    description: "End a prepared instance after all routes stop; initial lifecycle --expected-version 0; retain code for 7 days by default; does not delete files" },
  "cleanup-preview": { options: ["config", "data-root", "early", "archive-policy"],
    description: "Inspect ended instance code worktrees, retention, current archive protection and recoverability; returns a plan digest; --early bypasses time only" },
  cleanup: { options: ["config", "data-root", "expected-version", "plan-digest", "early", "archive-policy", "operation-id", "agent-id", "agent-name"],
    description: "Recheck a preview and remove only eligible code worktrees; keep blocked files, cache, pins and runtime evidence; interrupted operations require identical inputs and operation ID" },
} as const;

export async function executeCodeCleanup(input: { action: keyof typeof codeCleanupCommands; args: ParsedArgs;
  store: Store; cwd: string; attribution: () => Attribution; operationID: () => string }) {
  const { args, store, action } = input;
  const text = (key: string) => typeof args.values[key] === "string" && args.values[key] ? args.values[key] as string : undefined;
  const integer = (key: string) => {
    const value = text(key);
    if (!value || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw validation(key, "requires a nonnegative integer");
    return Number(value);
  };
  const boolean = (key: string) => String(args.values[key]).toLowerCase() === "true";
  if (action === "service-volume-delete") {
    if (!text("execution-id") || !text("archive-id")) throw validation("volume_delete", "requires execution-id and evidence archive-id");
    return { result_type: "grounds.result.service-cleanup/v1", command: `code-workspace.${action}`,
      deletion: await new CodeRouteServiceCleanup(store).deleteVolume({ route_id: args.positionals[2]!, execution_id: text("execution-id")!,
        archive_id: text("archive-id")!, operation_id: input.operationID(), attribution: input.attribution(),
        expected_version: integer("expected-version"), early: boolean("early") }) };
  }
  if (action === "service-volume-assess") {
    if (!text("execution-id") || !text("archive-id")) throw validation("assessment", "requires execution-id and recheck archive-id");
    return { result_type: "grounds.result.service-cleanup/v1", command: `code-workspace.${action}`,
      assessment: await new CodeRouteServiceCleanup(store).assessVolume({ route_id: args.positionals[2]!, execution_id: text("execution-id")!,
        archive_id: text("archive-id")!, early: boolean("early") }) };
  }
  if (action === "service-volume-restoration-cleanup") {
    if (!text("execution-id") || !text("restore-id")) throw validation("restoration_cleanup", "requires execution-id and restore-id");
    return { result_type: "grounds.result.service-cleanup/v1", command: `code-workspace.${action}`,
      cleanup: await new CodeRouteServiceCleanup(store).cleanupRestoration({ route_id: args.positionals[2]!, execution_id: text("execution-id")!,
        restore_id: text("restore-id")!, operation_id: input.operationID(), attribution: input.attribution(),
        early: boolean("early"), expected_version: integer("expected-version") }) };
  }
  if (action === "service-volume-retire") {
    if (!text("execution-id")) throw validation("execution-id", "requires the original stopped execution ID");
    if (args.values["restore-id"] !== undefined && !text("restore-id")) throw validation("restore-id", "requires completed restoration ID");
    return { result_type: "grounds.result.service-cleanup/v1", command: "code-workspace.service-volume-retire",
      retirement: await new CodeRouteServiceCleanup(store).retireVolume({ route_id: args.positionals[2]!, execution_id: text("execution-id")!,
        operation_id: input.operationID(), attribution: input.attribution(), ...(text("restore-id") ? { restore_id: text("restore-id")! } : {}) }) };
  }
  if (action === "service-volume-preview") {
    if (!text("execution-id")) throw validation("execution-id", "requires the original stopped execution ID");
    return { result_type: "grounds.result.service-cleanup/v1", command: "code-workspace.service-volume-preview",
      preview: await new CodeRouteServiceCleanup(store).volumePreview({ route_id: args.positionals[2]!, execution_id: text("execution-id")! }) };
  }
  if (action === "service-volume-restore" || action === "service-volume-restoration-show" || action === "service-volume-restoration-stop") {
    if (!text("execution-id")) throw validation("execution-id", "requires the original stopped execution ID");
    const service = new CodeRouteServiceCleanup(store), location = { route_id: args.positionals[2]!, execution_id: text("execution-id")! };
    const base = { result_type: "grounds.result.service-cleanup/v1", command: `code-workspace.${action}` };
    if (action === "service-volume-restoration-stop") {
      if (!text("restore-id")) throw validation("restore-id", "requires restoration ID");
      return { ...base, stopped: await service.stopRestoration({ ...location, restore_id: text("restore-id")!,
        operation_id: input.operationID(), attribution: input.attribution() }) };
    }
    if (action === "service-volume-restoration-show") {
      if (!text("restore-id")) throw validation("restore-id", "requires restoration ID");
      return { ...base, record: await service.restoration({ ...location, restore_id: text("restore-id")! }) };
    }
    if (!text("archive-id")) throw validation("archive-id", "requires a completed export ID");
    let checks;
    if (args.values["checks-file"] !== undefined) {
      if (!text("checks-file")) throw validation("checks-file", "requires a JSON file path");
      let document;
      try { document = JSON.parse(safeRead(resolve(input.cwd, text("checks-file")!), 64 * 1024).toString()); }
      catch { throw validation("checks-file", "requires a readable JSON file up to 64 KiB"); }
      if (!document || typeof document !== "object" || Object.keys(document).join(",") !== "checks")
        throw validation("checks-file", "requires exactly {checks:[...]}");
      validateVolumeChecks(document.checks); checks = document.checks;
    }
    return { ...base, restoration: await service.restoreVolume({ ...location, archive_id: text("archive-id")!,
      operation_id: input.operationID(), attribution: input.attribution(), ...(checks ? { checks } : {}) }) };
  }
  if (action === "service-volume-export") {
    if (args.values["verified-restore-id"] !== undefined && !text("verified-restore-id")) throw validation("verified-restore-id", "requires completed passing restoration ID");
    if (args.values["restore-id"] !== undefined && !text("restore-id")) throw validation("restore-id", "requires completed restoration ID");
    if (args.values["compare-archive-id"] !== undefined && !text("compare-archive-id")) throw validation("compare-archive-id", "requires archive ID");
    if (!text("execution-id")) throw validation("execution-id", "requires the original stopped execution ID");
    return { result_type: "grounds.result.service-cleanup/v1", command: "code-workspace.service-volume-export",
      archive: await new CodeRouteServiceCleanup(store).exportVolume({ route_id: args.positionals[2]!, execution_id: text("execution-id")!,
        operation_id: input.operationID(), attribution: input.attribution(),
        ...(text("verified-restore-id") ? { verified_restore_id: text("verified-restore-id")! } : {}),
        ...(text("restore-id") ? { restore_id: text("restore-id")! } : {}),
        ...(text("compare-archive-id") ? { compare_archive_id: text("compare-archive-id")! } : {}) }) };
  }
  if (action === "service-cleanup-preview" || action === "service-cleanup") {
    if (!text("execution-id")) throw validation("execution-id", "requires the original stopped execution ID");
    const service = new CodeRouteServiceCleanup(store), location = { route_id: args.positionals[2]!, execution_id: text("execution-id")!, early: boolean("early") };
    const base = { result_type: "grounds.result.service-cleanup/v1", command: `code-workspace.${action}` };
    if (action === "service-cleanup-preview") return { ...base, plan: await service.preview(location) };
    if (!text("plan-digest")) throw validation("plan-digest", "requires the fresh preview digest");
    return { ...base, cleanup: await service.reclaim({ ...location, operation_id: input.operationID(), attribution: input.attribution(),
      expected_version: integer("expected-version"), plan_digest: text("plan-digest")! }) };
  }
  const instance = await new CodeWorkspaces(store).instance(args.positionals[2]!);
  if (!instance.data_root) throw validation("instance", "requires a prepared local instance");
  const location = { instance_id: instance.instance_id, host_id: instance.host_id,
    data_root: text("data-root") ? resolve(input.cwd, text("data-root")!) : instance.data_root };
  const service = new CodeWorkspaceCleanup(store, { policyCheck: archivePolicyFor(store, input.cwd, text("archive-policy")) });
  const base = { result_type: "grounds.result.code-workspace/v1", command: `code-workspace.${action}` };
  if (action === "end") return { ...base, instance: await service.end({ ...location, operation_id: input.operationID(),
    attribution: input.attribution(), expected_version: integer("expected-version"),
    ...(args.values["retention-days"] !== undefined ? { retention_days: integer("retention-days") } : {}),
    ...(args.values.pinned !== undefined ? { pinned: boolean("pinned") } : {}) }) };
  const early = boolean("early");
  if (action === "cleanup-preview") return { ...base, plan: await service.preview({ ...location, early }) };
  if (!text("plan-digest")) throw validation("plan-digest", "requires the preview digest");
  return { ...base, cleanup: await service.reclaim({ ...location, early, expected_version: integer("expected-version"),
    plan_digest: text("plan-digest")!, operation_id: input.operationID(), attribution: input.attribution() }) };
}
