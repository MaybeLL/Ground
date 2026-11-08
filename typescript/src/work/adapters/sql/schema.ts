import type { SqlDialect } from "../../../sql-dialect.js";

/**
 * Tables of the work model (work ledger protocol 2, schema 2).
 *
 * One table per aggregate. What a rule needs the database to enforce (identity,
 * uniqueness, ordering, lookups) is a column; everything else is the aggregate
 * itself in `body_json`, protected by `record_digest`.
 *
 * No secondary-index statement is used: CREATE INDEX IF NOT EXISTS does not
 * exist on MySQL, so lookups are served by composite UNIQUE constraints that
 * end in the identity column, which every engine accepts in CREATE TABLE.
 * A NULL in a unique column never conflicts with another NULL.
 *
 * Foreign keys exist only where one row cannot exist without another
 * (a revision and its definition). Aggregates reference each other by
 * identity, because the model makes the application, not a foreign key, the
 * owner of cross-aggregate consistency.
 */
export const workTables = [
  "work_evidence_chunks", "work_evidence", "work_completion_events", "work_intents", "work_counters", "work_experiment_members", "work_experiment_runs",
  "work_gradings", "work_executions", "work_sandboxes", "work_task_runs", "work_works", "work_revisions", "work_definitions",
] as const;

/** Content-addressed binary evidence, written and verified in bounded chunks. */
export function evidenceSchemaStatements(dialect: SqlDialect): string[] {
  const digest = dialect.digestType;
  return [
    `CREATE TABLE IF NOT EXISTS work_evidence (digest ${digest} PRIMARY KEY, byte_length BIGINT NOT NULL CHECK (byte_length >= 0), chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0))`,
    `CREATE TABLE IF NOT EXISTS work_evidence_chunks (digest ${digest} NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal >= 0), chunk_digest ${digest} NOT NULL, bytes ${dialect.blobType} NOT NULL, PRIMARY KEY (digest, ordinal), FOREIGN KEY (digest) REFERENCES work_evidence(digest))`,
  ];
}

export function workSchemaStatements(dialect: SqlDialect): string[] {
  const id = dialect.boundedText(128);
  const key = dialect.boundedText(300);
  const word = dialect.boundedText(32);
  const stamp = dialect.boundedText(40);
  const digest = dialect.digestType;
  const text = dialect.textType;
  const common = `version INTEGER NOT NULL CHECK (version >= 1), record_digest ${digest} NOT NULL, body_json ${text} NOT NULL`;
  return [
    `CREATE TABLE IF NOT EXISTS work_definitions (id ${id} PRIMARY KEY, kind ${word} NOT NULL, head_seq INTEGER NOT NULL CHECK (head_seq >= 0), ${common}, UNIQUE (kind, id))`,
    `CREATE TABLE IF NOT EXISTS work_revisions (id ${id} PRIMARY KEY, definition_id ${id} NOT NULL, kind ${word} NOT NULL, seq INTEGER NOT NULL CHECK (seq >= 1), content_digest ${digest} NOT NULL, record_digest ${digest} NOT NULL, body_json ${text} NOT NULL, UNIQUE (definition_id, seq), FOREIGN KEY (definition_id) REFERENCES work_definitions(id))`,
    `CREATE TABLE IF NOT EXISTS work_works (id ${id} PRIMARY KEY, task_definition_id ${id} NOT NULL, status ${word} NOT NULL, head_run_id ${id} NULL, ${common}, UNIQUE (task_definition_id, id))`,
    `CREATE TABLE IF NOT EXISTS work_task_runs (id ${id} PRIMARY KEY, work_id ${id} NULL, refines_id ${id} NULL, task_definition_id ${id} NOT NULL, status ${word} NOT NULL, worker_execution_id ${id} NULL UNIQUE, ${common}, UNIQUE (work_id, id), UNIQUE (refines_id, id))`,
    `CREATE TABLE IF NOT EXISTS work_sandboxes (id ${id} PRIMARY KEY, owner_type ${word} NOT NULL, owner_id ${id} NOT NULL, phase ${word} NOT NULL, live_instance_id ${id} NULL UNIQUE, ${common}, UNIQUE (owner_type, owner_id, id))`,
    `CREATE TABLE IF NOT EXISTS work_executions (id ${id} PRIMARY KEY, owner_type ${word} NOT NULL, owner_id ${id} NOT NULL, role ${word} NOT NULL, stage ${word} NOT NULL, ${common}, UNIQUE (owner_type, owner_id, id))`,
    `CREATE TABLE IF NOT EXISTS work_gradings (id ${id} PRIMARY KEY, purpose ${word} NOT NULL, origin_type ${word} NOT NULL, task_run_id ${id} NULL, experiment_run_id ${id} NULL, case_key ${dialect.boundedText(256)} NULL, repeat_index INTEGER NULL, request_seq BIGINT NOT NULL UNIQUE, evaluator_execution_id ${id} NULL UNIQUE, status ${word} NOT NULL, ${common}, UNIQUE (task_run_id, id), UNIQUE (experiment_run_id, case_key, repeat_index, id))`,
    `CREATE TABLE IF NOT EXISTS work_experiment_runs (id ${id} PRIMARY KEY, experiment_id ${id} NOT NULL, ${common}, UNIQUE (experiment_id, id))`,
    `CREATE TABLE IF NOT EXISTS work_experiment_members (experiment_run_id ${id} NOT NULL, member_key ${key} NOT NULL, ordinal INTEGER NOT NULL, case_key ${dialect.boundedText(256)} NOT NULL, repeat_index INTEGER NOT NULL, task_run_request_id ${id} NOT NULL UNIQUE, PRIMARY KEY (experiment_run_id, member_key), UNIQUE (experiment_run_id, ordinal))`,
    `CREATE TABLE IF NOT EXISTS work_counters (name ${word} PRIMARY KEY, value BIGINT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS work_intents (id ${id} PRIMARY KEY, request_id ${id} NOT NULL UNIQUE, request_hash ${digest} NOT NULL, parent_intent_id ${id} NULL, kind ${word} NOT NULL, subject_type ${word} NOT NULL, subject_id ${id} NOT NULL, state ${word} NOT NULL, ${common}, UNIQUE (state, id), UNIQUE (parent_intent_id, id))`,
    `CREATE TABLE IF NOT EXISTS work_completion_events (seq ${dialect.eventSeqColumn}, id ${id} NOT NULL UNIQUE, parent_intent_id ${id} NOT NULL, event_type ${word} NOT NULL, created_at ${stamp} NOT NULL, delivered_at ${stamp} NULL, record_digest ${digest} NOT NULL, body_json ${text} NOT NULL, UNIQUE (delivered_at, seq))`,
    ...evidenceSchemaStatements(dialect),
  ];
}
