export interface Metadata {
  database_id: string;
  schema_version: number;
  protocol_version: number;
  minimum_cli_version: string;
  remote_normalization_version: number;
  baseline_reachability_policy: "warn" | "require_override";
  migration_state: "clean" | "dirty" | "in_progress";
}

export interface IntegrityIssue {
  check: string;
  resource_type?: string;
  resource_id?: string;
  reason: string;
}

export interface IntegrityReport {
  valid: boolean;
  issues: IntegrityIssue[];
}
