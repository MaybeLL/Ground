import type { Tx } from "./store-types.js";
import { sha256 } from "./canonical-json.js";
import { isUUIDv7 } from "./identity.js";

/** Domain snapshots predate CLI wrapping. Keep their replay bytes intact and
 * check the exact command/format pair against its persisted owner instead. */
export async function isWorkspaceOperationResult(tx: Tx, command: string, operationId: string, requestHash: string,
  result: Record<string, unknown>): Promise<boolean> {
  let format: string, id: unknown, mutable: string[] = [];
  switch (command) {
    case "code-workspace.recipe-save":
      format = "grounds.development-recipe/v1"; id = result.revision_id;
      if (result.request_digest !== requestHash) return false;
      break;
    case "code-workspace.recipe-prepare":
    case "code-workspace.recipe-preparation-cancel":
    case "code-workspace.recipe-preparation-cleanup":
      format = "grounds.development-image-preparation/v1"; id = result.preparation_id;
      if (command === "code-workspace.recipe-prepare") {
        if (id !== operationId || result.request_digest !== requestHash || result.state !== "registered") return false;
      } else {
        const marker = result[command.endsWith("cleanup") ? "cleanup" : "cancellation"] as Record<string, unknown> | undefined;
        if (!marker || !isUUIDv7(marker.operation_id)) return false;
        if (marker.operation_id === operationId) {
          if (requestHash !== sha256({ operation_id: operationId, preparation_id: id, attribution: marker.attribution })) return false;
        } else {
          if (!command.endsWith("cleanup") || marker.state !== "complete") return false;
          const owner = await tx.getRuntimeRecord("runtime_operation", String(id));
          if (sha256(owner?.data.cleanup) !== sha256(marker)) return false;
        }
      }
      mutable = ["state", "image", "cancellation", "cleanup", "environment_revision_id", "registration_error"];
      break;
    case "code-workspace.config-save":
      format = "grounds.workspace-configuration/v1"; id = result.revision_id;
      if (typeof result.version !== "number" || requestHash !== sha256({ configuration_id: result.configuration_id,
        expected_version: result.version - 1, configuration: result.configuration, attribution: result.attribution })) return false;
      break;
    case "code-workspace.create":
    case "code-workspace.restore":
    case "code-workspace.end":
      format = "grounds.code-workspace-instance/v1"; id = result.instance_id;
      mutable = ["state", "baselines", "data_root", "lifecycle"];
      if (!Array.isArray(result.baselines) || result.execution_enabled !== false
        || !["preparing", "prepared", "blocked"].includes(String(result.state))) return false;
      if ((command === "code-workspace.restore") !== (result.restoration !== undefined) && command !== "code-workspace.end") return false;
      if (command === "code-workspace.create") {
        const configuration = result.configuration as Record<string, unknown> | undefined;
        if (!configuration || requestHash !== sha256({ operation_id: operationId, configuration_id: configuration.configuration_id,
          configuration_version: configuration.version, issue_id: result.issue_id, issue_version: result.issue_version,
          host_id: result.host_id, attribution: result.attribution })) return false;
      }
      if (command === "code-workspace.restore") {
        const restoration = result.restoration as Record<string, unknown>;
        if (requestHash !== sha256({ operation_id: operationId, source_instance_id: restoration.source_instance_id,
          candidate_id: restoration.candidate_id, context_policy: "original", host_id: result.host_id, attribution: result.attribution })) return false;
      }
      if (command === "code-workspace.end" && (!result.lifecycle || (result.lifecycle as Record<string, unknown>).state !== "ended")) return false;
      break;
    case "code-workspace.route-bind":
      format = "grounds.code-workspace-route/v1"; id = result.route_id;
      if (result.dev_run_id !== operationId) return false;
      break;
    case "code-workspace.route-prepare": {
      if (result.route_id !== operationId || Object.keys(result).length !== 1) return false;
      const row = await tx.getRuntimeRecord("runtime_operation", operationId);
      return row?.data.format === "grounds.code-workspace-route/v1" && row.data.request_digest === requestHash;
    }
    case "code-workspace.environment-save":
      format = "grounds.repository-environment/v1"; id = result.revision_id;
      if (typeof result.version !== "number" || requestHash !== sha256({ environment_id: result.environment_id,
        repository_id: result.repository_id, expected_version: result.version - 1, configuration: result.configuration,
        attribution: result.attribution })) return false;
      break;
    case "code-workspace.environment-check":
      format = "grounds.repository-environment-check/v1"; id = result.check_id;
      if (id !== operationId || result.request_digest !== requestHash || result.state !== "registered") return false;
      mutable = ["state", "engine_id", "platform", "exit_code", "reason", "completed_at"];
      break;
    case "code-workspace.environment-set-default": {
      if (result.format !== "grounds.repository-environment-default/v1" || !isUUIDv7(result.check_id)
        || typeof result.version !== "number" || !Number.isSafeInteger(result.version) || result.version < 1) return false;
      const check = await tx.getRuntimeRecord("runtime_operation", result.check_id);
      const environment = check?.data.environment as Record<string, unknown> | undefined;
      return check?.data.format === "grounds.repository-environment-check/v1" && check.data.state === "passed"
        && environment?.repository_id === result.repository_id && environment?.revision_id === result.revision_id
        && requestHash === sha256({ operation_id: operationId, repository_id: result.repository_id,
          check_id: result.check_id, expected_version: result.version - 1, attribution: result.attribution });
    }
    case "code-workspace.build-material-capture":
      format = "grounds.repository-build-material/v1"; id = result.material_id;
      if (id !== operationId || result.request_digest !== requestHash) return false;
      break;
    case "code-workspace.image-prepare":
    case "code-workspace.image-cancel":
    case "code-workspace.image-cleanup":
      format = "grounds.repository-image-preparation/v1"; id = result.preparation_id;
      if (command === "code-workspace.image-prepare") {
        if (id !== operationId || result.request_digest !== requestHash || result.state !== "registered") return false;
      } else {
        const cancelling = command === "code-workspace.image-cancel";
        const terminal = ["failed", "cancelled"].includes(String(result.state));
        const marker = result[cancelling ? "cancellation" : "cleanup"] as Record<string, unknown> | undefined;
        if (cancelling ? (!terminal && !["building", "needs-recovery"].includes(String(result.state)))
          : (!["ready", "failed", "cancelled"].includes(String(result.state)))) return false;
        if ((!cancelling || !terminal) && !marker) return false;
        if (marker) {
          if (!isUUIDv7(marker.operation_id) || !marker.attribution || (!cancelling && !["pending", "complete"].includes(String(marker.state)))) return false;
          if (marker.operation_id === operationId && requestHash !== sha256({ operation_id: operationId,
            preparation_id: id, attribution: marker.attribution })) return false;
          const owner = await tx.getRuntimeRecord("runtime_operation", String(id));
          const current = owner?.data[cancelling ? "cancellation" : "cleanup"] as Record<string, unknown> | undefined;
          const identity = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "state"));
          if (!current || sha256(identity(marker)) !== sha256(identity(current))) return false;
        }
        // A no-op may be performed by a different actor after an earlier action.
        // Historical snapshots do not retain that caller; do not invent an attribution.
      }
      mutable = ["state", "cleanup", "cancellation", "image", "reused", "producer_id"];
      break;
    default: {
      const formats: Record<string, string> = {
        "code-workspace.service-cleanup": "grounds.route-service-cleanup/v1",
        "code-workspace.service-volume-retire": "grounds.volume-retirement-operation/v1",
        "code-workspace.service-volume-export": "grounds.service-volume-export-operation/v1",
        "code-workspace.service-volume-restore": "grounds.service-volume-restoration-operation/v1",
        "code-workspace.service-volume-restoration-cleanup": "grounds.restoration-cleanup-operation/v1",
        "code-workspace.service-volume-restoration-stop": "grounds.service-volume-stop-operation/v1",
        "code-workspace.service-volume-delete": "grounds.volume-deletion-operation/v1",
      };
      if (!Object.hasOwn(formats, command) || result.request_digest !== requestHash || result.phase !== "pending") return false;
      format = formats[command]!; id = operationId; mutable = ["phase", "result"];
    }
  }
  if (result.format !== format || typeof id !== "string" || !isUUIDv7(id)) return false;
  const row = await tx.getRuntimeRecord("runtime_operation", id);
  if (!row || row.data.format !== format) return false;
  const fixed = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !mutable.includes(key)));
  return sha256(fixed(row.data)) === sha256(fixed(result));
}
