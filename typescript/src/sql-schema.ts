// Schema definition and migration statements.  This module owns table shapes
// and the additive steps that bring an older database forward; the transaction
// code owns business rules.  Keeping them apart is what stops a schema change
// from having to be reasoned about beside every query.
//
// Every engine-specific shape here is expressed through SqlDialect capabilities
// rather than a dialect name, so a new engine needs no edit in this file except
// where its DDL genuinely differs.

import { DomainError, schemaDetails } from "./errors.js";
import type { SQLClient } from "./sql-client.js";
import type { SqlDialect } from "./sql-dialect.js";

export const SCHEMA_VERSION = 23;
export const PROTOCOL_VERSION = 1;
export const REMOTE_NORMALIZATION_VERSION = 1;
export const MINIMUM_CLI_VERSION = "0.1.0";

/** Table shapes for the current schema version. */
export const schemaStatements = (dialect: SqlDialect): string[] => {
  const type = {
    id: dialect.idType,
    remote: dialect.needsRemoteDigest ? dialect.boundedBinary(4096) : dialect.textType,
    digest: dialect.digestType,
    text: dialect.textType,
    blob: dialect.blobType,
    eventSeq: dialect.eventSeqColumn,
  };
  const rawDigest = dialect.rawDigestType;
  const id = type.id;
  const remote = type.remote;
  const text = type.text;
  const blob = type.blob;
  // Engines that cannot index an unbounded remote keep a SHA-256 digest
  // beside it and key on the digest; engines that can key on the remote itself.
  const repositoryDDL = dialect.needsRemoteDigest
    ? `repositories (id ${id} PRIMARY KEY, canonical_remote ${remote} NOT NULL, canonical_remote_digest ${rawDigest} NOT NULL UNIQUE, version INTEGER NOT NULL CHECK (version >= 1), created_at ${text} NOT NULL, attribution_json ${text} NOT NULL)`
    : `repositories (id ${id} PRIMARY KEY, canonical_remote ${remote} NOT NULL UNIQUE, version INTEGER NOT NULL CHECK (version >= 1), created_at ${text} NOT NULL, attribution_json ${text} NOT NULL)`;
  const remoteDDL = dialect.needsRemoteDigest
    ? `repository_remotes (repository_id ${id} NOT NULL, remote ${remote} NOT NULL, remote_digest ${rawDigest} NOT NULL, state VARCHAR(16) NOT NULL CHECK (state IN ('active', 'retired')), PRIMARY KEY(repository_id, remote_digest), UNIQUE(remote_digest), FOREIGN KEY(repository_id) REFERENCES repositories(id))`
    : `repository_remotes (repository_id ${id} NOT NULL, remote ${remote} NOT NULL, state VARCHAR(16) NOT NULL CHECK (state IN ('active', 'retired')), PRIMARY KEY(repository_id, remote), UNIQUE(remote), FOREIGN KEY(repository_id) REFERENCES repositories(id))`;
  const statements = [
    `CREATE TABLE IF NOT EXISTS runtime_records (id ${id} PRIMARY KEY, kind VARCHAR(32) NOT NULL, parent_id ${id}, version INTEGER NOT NULL CHECK (version >= 1), record_digest ${type.digest} NOT NULL, record_json ${type.text} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS eval_blobs (digest ${type.digest} PRIMARY KEY, size INTEGER NOT NULL, chunk_count INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS eval_blob_chunks (digest ${type.digest} NOT NULL, ordinal INTEGER NOT NULL, bytes ${blob} NOT NULL, PRIMARY KEY(digest, ordinal), FOREIGN KEY(digest) REFERENCES eval_blobs(digest))`,
    `CREATE TABLE IF NOT EXISTS eval_records (id ${id} NOT NULL, kind VARCHAR(16) NOT NULL, version INTEGER NOT NULL CHECK (version >= 1), parent_id ${id}, record_digest ${type.digest} NOT NULL, record_json ${type.text} NOT NULL, PRIMARY KEY(id, version))`,
    `CREATE TABLE IF NOT EXISTS schema_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), database_id ${id} NOT NULL, schema_version INTEGER NOT NULL, protocol_version INTEGER NOT NULL, minimum_cli_version ${text} NOT NULL, remote_normalization_version INTEGER NOT NULL, baseline_reachability_policy ${text} NOT NULL CHECK (baseline_reachability_policy IN ('warn', 'require_override')), migration_state ${text} NOT NULL CHECK (migration_state IN ('clean', 'dirty', 'in_progress')))`,
    `CREATE TABLE IF NOT EXISTS schema_migrations (schema_version INTEGER PRIMARY KEY, applied_at ${text} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${repositoryDDL}`,
    `CREATE TABLE IF NOT EXISTS ${remoteDDL}`,
    `CREATE TABLE IF NOT EXISTS requirements (id ${id} PRIMARY KEY, created_at ${text} NOT NULL, attribution_json ${text} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS requirement_revisions (id ${id} PRIMARY KEY, requirement_id ${id} NOT NULL, predecessor_revision_id ${id}, revision_number INTEGER NOT NULL CHECK (revision_number >= 1), summary ${text} NOT NULL, context ${text}, created_at ${text} NOT NULL, attribution_json ${text} NOT NULL, UNIQUE(requirement_id, revision_number), UNIQUE(predecessor_revision_id), UNIQUE(id, requirement_id), FOREIGN KEY(requirement_id) REFERENCES requirements(id), FOREIGN KEY(predecessor_revision_id, requirement_id) REFERENCES requirement_revisions(id, requirement_id))`,
    `CREATE TABLE IF NOT EXISTS requirement_outcomes (requirement_revision_id ${id} NOT NULL, ordinal INTEGER NOT NULL, statement ${text} NOT NULL, PRIMARY KEY(requirement_revision_id, ordinal), FOREIGN KEY(requirement_revision_id) REFERENCES requirement_revisions(id))`,
    `CREATE TABLE IF NOT EXISTS requirement_decisions (requirement_revision_id ${id} NOT NULL, ordinal INTEGER NOT NULL, statement ${text} NOT NULL, rationale ${text}, details_json ${text}, PRIMARY KEY(requirement_revision_id, ordinal), FOREIGN KEY(requirement_revision_id) REFERENCES requirement_revisions(id))`,
    `CREATE TABLE IF NOT EXISTS requirement_open_questions (requirement_revision_id ${id} NOT NULL, ordinal INTEGER NOT NULL, question ${text} NOT NULL, blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)), assumption ${text}, PRIMARY KEY(requirement_revision_id, ordinal), FOREIGN KEY(requirement_revision_id) REFERENCES requirement_revisions(id))`,
    `CREATE TABLE IF NOT EXISTS issues (id ${id} PRIMARY KEY, requirement_id ${id} NOT NULL, repository_id ${id} NOT NULL, created_at ${text} NOT NULL, attribution_json ${text} NOT NULL, UNIQUE(id, requirement_id), FOREIGN KEY(requirement_id) REFERENCES requirements(id), FOREIGN KEY(repository_id) REFERENCES repositories(id))`,
    `CREATE TABLE IF NOT EXISTS issue_revisions (id ${id} PRIMARY KEY, issue_id ${id} NOT NULL, requirement_id ${id} NOT NULL, requirement_revision_id ${id} NOT NULL, predecessor_revision_id ${id}, revision_number INTEGER NOT NULL CHECK (revision_number >= 1), baseline_oid ${text} NOT NULL, baseline_reachability VARCHAR(32) NOT NULL CHECK (baseline_reachability IN ('remote_tracking_reachable', 'unconfirmed')), baseline_warning ${text}, baseline_override_reason ${text}, summary ${text} NOT NULL, context ${text}, plan ${text}, created_at ${text} NOT NULL, attribution_json ${text} NOT NULL, UNIQUE(id, issue_id), UNIQUE(issue_id, revision_number), UNIQUE(predecessor_revision_id), FOREIGN KEY(issue_id, requirement_id) REFERENCES issues(id, requirement_id), FOREIGN KEY(requirement_revision_id, requirement_id) REFERENCES requirement_revisions(id, requirement_id), FOREIGN KEY(predecessor_revision_id, issue_id) REFERENCES issue_revisions(id, issue_id))`,
    `CREATE TABLE IF NOT EXISTS issue_target_branches (issue_revision_id ${id} PRIMARY KEY, remote_name ${text} NOT NULL, branch_ref ${text} NOT NULL, FOREIGN KEY(issue_revision_id) REFERENCES issue_revisions(id))`,
    `CREATE TABLE IF NOT EXISTS goals (id ${id} PRIMARY KEY, issue_revision_id ${id} NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal >= 0), statement ${text} NOT NULL, UNIQUE(issue_revision_id, ordinal), FOREIGN KEY(issue_revision_id) REFERENCES issue_revisions(id))`,
    `CREATE TABLE IF NOT EXISTS constraints (id ${id} PRIMARY KEY, issue_revision_id ${id} NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal >= 0), statement ${text} NOT NULL, rationale ${text}, UNIQUE(issue_revision_id, ordinal), FOREIGN KEY(issue_revision_id) REFERENCES issue_revisions(id))`,
    `CREATE TABLE IF NOT EXISTS criteria (id ${id} PRIMARY KEY, issue_revision_id ${id} NOT NULL, target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('goal', 'constraint')), target_id ${id} NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal >= 0), statement ${text} NOT NULL, UNIQUE(target_id, ordinal), FOREIGN KEY(issue_revision_id) REFERENCES issue_revisions(id))`,
    `CREATE TABLE IF NOT EXISTS target_guidance (issue_revision_id ${id} NOT NULL, target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('goal', 'constraint')), target_id ${id} NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal >= 0), statement ${text} NOT NULL, PRIMARY KEY(target_id, ordinal), FOREIGN KEY(issue_revision_id) REFERENCES issue_revisions(id))`,
    `CREATE TABLE IF NOT EXISTS intent_links (issue_revision_id ${id} NOT NULL, target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('goal', 'constraint')), target_id ${id} NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal >= 0), intent_type VARCHAR(16) NOT NULL CHECK (intent_type IN ('outcome', 'decision')), intent_ordinal INTEGER NOT NULL CHECK (intent_ordinal >= 1 AND intent_ordinal <= 100), PRIMARY KEY(target_id, ordinal), UNIQUE(target_id, intent_type, intent_ordinal), FOREIGN KEY(issue_revision_id) REFERENCES issue_revisions(id))`,
    // The refinement parent points forward to candidates, which in turn points
    // back to dev_runs.  Keeping this edge at the Work Module boundary avoids
    // a cyclic CREATE TABLE dependency on both SQLite and MySQL; integrity
    // diagnostics verify the parent relationship separately.
    `CREATE TABLE IF NOT EXISTS dev_runs (id ${id} PRIMARY KEY, issue_revision_id ${id} NOT NULL, version INTEGER NOT NULL CHECK (version >= 1), state VARCHAR(16) NOT NULL CHECK (state IN ('open', 'submitted', 'abandoned')), exploration_brief ${text}, refines_candidate_id ${id}, repository_remote_snapshot ${text} NOT NULL, abandon_reason ${text}, created_at ${text} NOT NULL, attribution_json ${text} NOT NULL, UNIQUE(id, issue_revision_id), FOREIGN KEY(issue_revision_id) REFERENCES issue_revisions(id)${dialect.inlineForwardForeignKey ? ", FOREIGN KEY(refines_candidate_id) REFERENCES candidates(id)" : ""})`,
    `CREATE TABLE IF NOT EXISTS artifact_blobs (patch_digest ${type.digest} PRIMARY KEY, codec VARCHAR(16) NOT NULL CHECK (codec = 'zlib'), uncompressed_size INTEGER NOT NULL CHECK (uncompressed_size >= 0), compressed_size INTEGER NOT NULL CHECK (compressed_size >= 0), chunk_count INTEGER NOT NULL CHECK (chunk_count >= 1))`,
    `CREATE TABLE IF NOT EXISTS artifact_chunks (patch_digest ${type.digest} NOT NULL, ordinal INTEGER NOT NULL, bytes ${blob} NOT NULL, PRIMARY KEY(patch_digest, ordinal), FOREIGN KEY(patch_digest) REFERENCES artifact_blobs(patch_digest))`,
    `CREATE TABLE IF NOT EXISTS candidates (id ${id} PRIMARY KEY, dev_run_id ${id} NOT NULL UNIQUE, issue_revision_id ${id} NOT NULL, repository_remote_snapshot ${text} NOT NULL, submission_format VARCHAR(64) NOT NULL CHECK (submission_format IN ('patchledger.candidate-submission/v1', 'patchledger.candidate-submission/v2')), submission_explanation ${text} NOT NULL, patch_digest ${type.digest} NOT NULL, result_tree_oid ${text} NOT NULL, artifact_format ${text} NOT NULL CHECK (artifact_format IN ('patchledger.git-full-index-binary-patch/v1', 'grounds.git-commit-artifact/v1')), blind_context_digest ${type.digest} NOT NULL, created_at ${text} NOT NULL, attribution_json ${text} NOT NULL, FOREIGN KEY(dev_run_id, issue_revision_id) REFERENCES dev_runs(id, issue_revision_id), FOREIGN KEY(issue_revision_id) REFERENCES issue_revisions(id))`,
    `CREATE TABLE IF NOT EXISTS candidate_git_artifacts (candidate_id ${id} PRIMARY KEY, metadata_json ${text} NOT NULL, metadata_digest ${type.digest} NOT NULL, patch_size INTEGER NOT NULL CHECK (patch_size >= 0), FOREIGN KEY(candidate_id) REFERENCES candidates(id))`,
    `CREATE TABLE IF NOT EXISTS delivery_links (id ${id} PRIMARY KEY, candidate_id ${id} NOT NULL, repository_id ${id} NOT NULL, commit_oid VARCHAR(64) NOT NULL, version INTEGER NOT NULL, UNIQUE(candidate_id, commit_oid), FOREIGN KEY(candidate_id) REFERENCES candidates(id), FOREIGN KEY(repository_id) REFERENCES repositories(id))`,
    `CREATE TABLE IF NOT EXISTS delivery_link_versions (link_id ${id} NOT NULL, version INTEGER NOT NULL, record_digest ${type.digest} NOT NULL, record_json ${text} NOT NULL, PRIMARY KEY(link_id, version), FOREIGN KEY(link_id) REFERENCES delivery_links(id))`,
    `CREATE TABLE IF NOT EXISTS issue_completion_versions (issue_revision_id ${id} NOT NULL, version INTEGER NOT NULL CHECK (version >= 1), state VARCHAR(16) NOT NULL CHECK (state IN ('completed', 'reopened')), record_digest ${type.digest} NOT NULL, record_json ${text} NOT NULL, PRIMARY KEY(issue_revision_id, version), FOREIGN KEY(issue_revision_id) REFERENCES issue_revisions(id))`,
    `CREATE TABLE IF NOT EXISTS selections (id ${id} PRIMARY KEY, issue_revision_id ${id} NOT NULL UNIQUE, candidate_id ${id}, version INTEGER NOT NULL CHECK (version >= 1), updated_at ${text} NOT NULL, attribution_json ${text} NOT NULL, reason ${text}, verification_json ${text}, CHECK ((candidate_id IS NULL AND verification_json IS NULL) OR (candidate_id IS NOT NULL AND verification_json IS NOT NULL)), FOREIGN KEY(issue_revision_id) REFERENCES issue_revisions(id), FOREIGN KEY(candidate_id) REFERENCES candidates(id))`,
    `CREATE TABLE IF NOT EXISTS dev_run_bases (dev_run_id ${id} PRIMARY KEY, base_commit ${text} NOT NULL, FOREIGN KEY(dev_run_id) REFERENCES dev_runs(id))`,
    `CREATE TABLE IF NOT EXISTS candidate_bases (candidate_id ${id} PRIMARY KEY, base_commit ${text} NOT NULL, FOREIGN KEY(candidate_id) REFERENCES candidates(id))`,
    `CREATE TABLE IF NOT EXISTS candidate_files (candidate_id ${id} NOT NULL, ordinal INTEGER NOT NULL, path_bytes ${dialect.boundedBinary(1024)} NOT NULL, display_path ${text} NOT NULL, change_kind VARCHAR(32) NOT NULL, old_path_bytes ${dialect.boundedBinary(1024)}, old_mode VARCHAR(16), new_mode VARCHAR(16), PRIMARY KEY(candidate_id, ordinal), UNIQUE(candidate_id, path_bytes), FOREIGN KEY(candidate_id) REFERENCES candidates(id))`,
    `CREATE TABLE IF NOT EXISTS candidate_claims (candidate_id ${id} NOT NULL, target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('goal', 'constraint')), target_id ${id} NOT NULL, explanation ${text} NOT NULL, PRIMARY KEY(candidate_id, target_type, target_id), FOREIGN KEY(candidate_id) REFERENCES candidates(id))`,
    `CREATE TABLE IF NOT EXISTS candidate_claim_criteria (candidate_id ${id} NOT NULL, target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('goal', 'constraint')), target_id ${id} NOT NULL, criterion_id ${id} NOT NULL, explanation ${text} NOT NULL, self_verification_json ${text}, PRIMARY KEY(candidate_id, target_type, target_id, criterion_id), FOREIGN KEY(candidate_id, target_type, target_id) REFERENCES candidate_claims(candidate_id, target_type, target_id))`,
    `CREATE TABLE IF NOT EXISTS candidate_evidence (candidate_id ${id} NOT NULL, target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('goal', 'constraint')), target_id ${id} NOT NULL, criterion_id ${id} NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal >= 0), command ${text} NOT NULL, exit_code INTEGER NOT NULL, output ${text}, output_digest ${type.digest} NOT NULL, PRIMARY KEY(candidate_id, target_type, target_id, criterion_id, ordinal), FOREIGN KEY(candidate_id, target_type, target_id, criterion_id) REFERENCES candidate_claim_criteria(candidate_id, target_type, target_id, criterion_id))`,
    `CREATE TABLE IF NOT EXISTS candidate_change_rationales (candidate_id ${id} NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal >= 0), rationale_json ${text} NOT NULL, PRIMARY KEY(candidate_id, ordinal), FOREIGN KEY(candidate_id) REFERENCES candidates(id))`,
    `CREATE TABLE IF NOT EXISTS verifications (id ${id} PRIMARY KEY, candidate_id ${id} NOT NULL, result_tree_oid ${text} NOT NULL, blind_context_digest ${type.digest} NOT NULL, overall_verdict VARCHAR(16) NOT NULL CHECK (overall_verdict IN ('qualified', 'rejected', 'inconclusive')), created_at ${text} NOT NULL, attribution_json ${text} NOT NULL, UNIQUE(id, candidate_id), FOREIGN KEY(candidate_id) REFERENCES candidates(id))`,
    `CREATE TABLE IF NOT EXISTS verification_assessments (verification_id ${id} NOT NULL, target_type VARCHAR(16) NOT NULL CHECK (target_type IN ('goal', 'constraint')), target_id ${id} NOT NULL, criterion_id ${id} NOT NULL, independent_verdict VARCHAR(16) NOT NULL CHECK (independent_verdict IN ('qualified', 'rejected', 'inconclusive')), independent_explanation ${text} NOT NULL, reconciliation_relation VARCHAR(32) NOT NULL CHECK (reconciliation_relation IN ('corroborated', 'contradicted', 'not_determined')), reconciliation_explanation ${text} NOT NULL, final_verdict VARCHAR(16) NOT NULL CHECK (final_verdict IN ('qualified', 'rejected', 'inconclusive')), final_explanation ${text} NOT NULL, PRIMARY KEY(verification_id, target_type, target_id, criterion_id), FOREIGN KEY(verification_id) REFERENCES verifications(id))`,
    `CREATE TABLE IF NOT EXISTS verification_evidence (verification_id ${id} NOT NULL, target_type VARCHAR(16) NOT NULL, target_id ${id} NOT NULL, criterion_id ${id} NOT NULL, ordinal INTEGER NOT NULL, command ${text} NOT NULL, exit_code INTEGER NOT NULL, output ${text}, output_digest ${type.digest} NOT NULL, PRIMARY KEY(verification_id, target_type, target_id, criterion_id, ordinal), FOREIGN KEY(verification_id, target_type, target_id, criterion_id) REFERENCES verification_assessments(verification_id, target_type, target_id, criterion_id))`,
    `CREATE TABLE IF NOT EXISTS verification_quality_reviews (verification_id ${id} PRIMARY KEY, rubric_version ${text} NOT NULL, overall_verdict VARCHAR(16) NOT NULL CHECK (overall_verdict IN ('qualified', 'rejected', 'inconclusive')), attribution_json ${text} NOT NULL, report_json ${text} NOT NULL, FOREIGN KEY(verification_id) REFERENCES verifications(id))`,
    `CREATE TABLE IF NOT EXISTS dev_run_refinement_verifications (dev_run_id ${id} NOT NULL, verification_id ${id} NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY(dev_run_id, verification_id), UNIQUE(dev_run_id, ordinal), FOREIGN KEY(dev_run_id) REFERENCES dev_runs(id), FOREIGN KEY(verification_id) REFERENCES verifications(id))`,
    `CREATE TABLE IF NOT EXISTS idempotency_records (operation_id ${id} PRIMARY KEY, command ${text} NOT NULL, request_hash ${type.digest} NOT NULL, status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'completed')), result_json ${blob}, created_at ${text} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ledger_events (event_seq ${type.eventSeq}, event_id ${id} NOT NULL UNIQUE, event_type ${text} NOT NULL, event_version INTEGER NOT NULL, operation_id ${id} NOT NULL, repository_id ${id}, subject_type VARCHAR(64) NOT NULL, subject_id ${id} NOT NULL, subject_version INTEGER, occurred_at ${text} NOT NULL, attribution_json ${text} NOT NULL, facts_json ${text} NOT NULL, FOREIGN KEY(operation_id) REFERENCES idempotency_records(operation_id), FOREIGN KEY(repository_id) REFERENCES repositories(id))`,
  ];
  return statements;
};

/** Create every table (idempotent) and, for engines that cannot declare the
 * forward foreign key inline, install it once the referenced table exists. */
export const applySchema = async (client: SQLClient, dialect: SqlDialect, ensureRefinementForeignKey = true): Promise<void> => {
    for (let statement of schemaStatements(dialect)) {
      if (dialect.tableSuffix && statement.startsWith("CREATE TABLE")) statement += dialect.tableSuffix;
      await client.exec(statement);
    }
    if (!dialect.inlineForwardForeignKey && ensureRefinementForeignKey) {
      const existing = await client.get<{ present: unknown }>(dialect.constraintExistsSql("dev_runs", "fk_dev_runs_refines_candidate"));
      if (Number(existing?.present ?? 0) === 0) await client.exec("ALTER TABLE dev_runs ADD CONSTRAINT fk_dev_runs_refines_candidate FOREIGN KEY (refines_candidate_id) REFERENCES candidates(id)");
    }
};

const hasColumn = async (client: SQLClient, dialect: SqlDialect, table: string, column: string): Promise<boolean> => {
    const row = await client.get<{ present: unknown }>(dialect.columnExistsSql(table, column));
    return Number(row?.present ?? 0) === 1;
};

  /** Apply additive columns that CREATE TABLE IF NOT EXISTS cannot install on
   * an existing table. Existing Candidates are v1 by definition; v2 writes
   * only become possible after this migration records their format.
   * CREATE TABLE IF NOT EXISTS cannot alter a table that already exists, so
   * migrations must make these changes explicitly and refuse to guess when
   * old Candidate rows would need a fabricated digest.
   */
export const ensureLegacyColumns = async (client: SQLClient, dialect: SqlDialect): Promise<void> => {
    if (!(await hasColumn(client, dialect, "candidate_claim_criteria", "self_verification_json"))) {
      await client.exec(`ALTER TABLE candidate_claim_criteria ADD COLUMN self_verification_json ${dialect.textType} NULL`);
    }
    if (!(await hasColumn(client, dialect, "requirement_decisions", "details_json"))) {
      await client.exec(`ALTER TABLE requirement_decisions ADD COLUMN details_json ${dialect.textType} NULL`);
    }
    // Schema 21: the non-normative Issue plan. Nullable and additive, so rows
    // published before this version keep their bytes and read back as absent.
    if (!(await hasColumn(client, dialect, "issue_revisions", "plan"))) {
      await client.exec(`ALTER TABLE issue_revisions ADD COLUMN plan ${dialect.textType} NULL`);
    }
    if (!(await hasColumn(client, dialect, "candidates", "blind_context_digest"))) {
      const row = await client.get<{ count: unknown }>("SELECT COUNT(*) AS count FROM candidates");
      if (Number(row?.count ?? 0) !== 0) throw new DomainError("SCHEMA_INCOMPATIBLE", "existing Candidates cannot be migrated to the blind-context digest contract", false, schemaDetails(SCHEMA_VERSION, "legacy candidates without blind_context_digest"));
      const type = dialect.digestType;
      await client.exec(`ALTER TABLE candidates ADD COLUMN blind_context_digest ${type} NOT NULL DEFAULT ''`);
    }
    if (!(await hasColumn(client, dialect, "dev_runs", "refines_candidate_id"))) {
      await client.exec(`ALTER TABLE dev_runs ADD COLUMN refines_candidate_id ${dialect.idType} NULL${dialect.inlineForwardForeignKey ? " REFERENCES candidates(id)" : ""}`);
    }
    if (!(await hasColumn(client, dialect, "candidates", "submission_format"))) {
      const type = dialect.boundedText(64);
      await client.exec(`ALTER TABLE candidates ADD COLUMN submission_format ${type} NOT NULL DEFAULT 'patchledger.candidate-submission/v1'`);
    }
};

/** Schema 22 removes the assumption that every Candidate's code lives in SQL.
 * Legacy patch bytes and all immutable Candidate columns remain unchanged.
 * SQLite callers must disable FK enforcement before opening the migration
 * transaction, then run foreign_key_check before committing and re-enable it.
 */
export const migrateCandidateArtifacts = async (client: SQLClient, dialect: SqlDialect): Promise<void> => {
  if (dialect.tableRebuild) {
    const row = await client.get<{ sql: unknown }>(dialect.tableRebuild.definitionSql("candidates"));
    const ddl = String(row?.sql ?? "");
    if (!ddl.includes("REFERENCES artifact_blobs") && ddl.includes("grounds.git-commit-artifact/v1")) return;
    const statement = schemaStatements(dialect).find(s => s.startsWith("CREATE TABLE IF NOT EXISTS candidates ("))!;
    await client.exec(statement.replace("IF NOT EXISTS candidates (", "candidates_v22 ("));
    const columns = "id, dev_run_id, issue_revision_id, repository_remote_snapshot, submission_format, submission_explanation, patch_digest, result_tree_oid, artifact_format, blind_context_digest, created_at, attribution_json";
    await client.exec(`INSERT INTO candidates_v22 (${columns}) SELECT ${columns} FROM candidates`);
    // Do not rename the old parent: that would rewrite child FK declarations.
    await client.exec("DROP TABLE candidates");
    await client.exec("ALTER TABLE candidates_v22 RENAME TO candidates");
    return;
  }
  const catalog = dialect.constraintEditing;
  if (!catalog) throw new DomainError("SCHEMA_INCOMPATIBLE", "Dialect does not support Candidate artifact constraint migration");
  const foreignKeys = await client.all<{ name: unknown }>(catalog.foreignKeysSql("candidates", "patch_digest", "artifact_blobs"));
  for (const row of foreignKeys) await client.exec(catalog.dropForeignKeySql("candidates", String(row.name)));
  const checks = await client.all<{ name: unknown; definition: unknown }>(catalog.checksSql("candidates"));
  let current = false;
  for (const row of checks) {
    const definition = String(row.definition);
    if (!definition.includes("artifact_format")) continue;
    if (definition.includes("grounds.git-commit-artifact/v1")) { current = true; continue; }
    await client.exec(catalog.dropCheckSql("candidates", String(row.name)));
  }
  if (!current) await client.exec("ALTER TABLE candidates ADD CONSTRAINT grounds_candidate_artifact_format CHECK (artifact_format IN ('patchledger.git-full-index-binary-patch/v1', 'grounds.git-commit-artifact/v1'))");
};
