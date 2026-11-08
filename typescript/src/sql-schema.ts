import type { SQLClient } from "./sql-client.js";
import type { SqlDialect } from "./sql-dialect.js";
import { workSchemaStatements } from "./work/adapters/sql/schema.js";

// The protocol identifies the new ledger family, including when the old and
// new families happen to have the same numeric schema version.
export const SCHEMA_VERSION = 1;
export const PROTOCOL_VERSION = 2;
export const REMOTE_NORMALIZATION_VERSION = 1;
export const MINIMUM_CLI_VERSION = "0.2.53";

export const schemaStatements = (dialect: SqlDialect): string[] => {
  const id = dialect.idType, text = dialect.textType;
  return [
    `CREATE TABLE IF NOT EXISTS schema_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), database_id ${id} NOT NULL, schema_version INTEGER NOT NULL, protocol_version INTEGER NOT NULL, minimum_cli_version ${text} NOT NULL, remote_normalization_version INTEGER NOT NULL, baseline_reachability_policy ${text} NOT NULL CHECK (baseline_reachability_policy IN ('warn', 'require_override')), migration_state ${text} NOT NULL CHECK (migration_state IN ('clean', 'dirty', 'in_progress')))`,
    ...workSchemaStatements(dialect),
  ];
};

export async function applySchema(client: SQLClient, dialect: SqlDialect): Promise<void> {
  for (const statement of schemaStatements(dialect)) await client.exec(statement + dialect.tableSuffix);
}
