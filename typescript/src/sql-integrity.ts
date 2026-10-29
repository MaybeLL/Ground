import { DomainError } from "./errors.js";
import type { GitArtifactResolver } from "./git-artifact-storage.js";
import { RETIRED_RUNTIME_KINDS } from "./runtime-record.js";
import { isSyncRecord, syncData, syncTerminal } from "./devrun-sync-record.js";
import { type EvalKind } from "./evaluation.js";
import { createHash } from "node:crypto";
import { isUUIDv7 } from "./identity.js";
import { sha256 } from "./canonical-json.js";
import { validateCanonicalRemote } from "./git.js";
import type { SqlDialect } from "./sql-dialect.js";
import { type SQLClient } from "./sql-client.js";
import { indexCandidateChanges } from "./change-index.js";
import { type Candidate, type DevRun, type Goal, type IssueRevision, type RequirementRevision, type Verification, validateBaseline, validateVerificationReport } from "./domain.js";
import { combinedVerdict } from "./quality-review.js";
import type { IntegrityIssue, IntegrityReport, LedgerEvent, Metadata } from "./store-types.js";

export const PROTOCOL_VERSION = 1;
export const REMOTE_NORMALIZATION_VERSION = 1;
export const MINIMUM_CLI_VERSION = "0.1.0";
const CLI_VERSION = "0.1.0";
import { asText, asDigestBuffer, parseJSON, validResourceId, parseAttribution, parseDate, safeInteger, storedOperation, validatePersistedCandidateArtifact, StoredOperationRow } from "./sql-shared.js";

import { SqlTx } from "./sql-tx.js";
import { isWorkspaceOperationResult } from "./workspace-operation-integrity.js";

/** Whole-database integrity sweep.  Runs inside one read snapshot: every paged scan
 * below shares the transaction opened here, so a concurrent writer cannot make a
 * page skip or repeat rows.  Moved from SQLStore verbatim apart from reading the
 * dialect/client as parameters. */
export const scanIntegrity = async (dialect: SqlDialect, client: SQLClient, metadata: Metadata, gitArtifactResolver?: GitArtifactResolver): Promise<{ metadata: Metadata; report: IntegrityReport }> => {
      await client.begin(false, false);
      const issues: IntegrityIssue[] = [];
      const add = (check: string, resourceType: string, resourceId: string | undefined, reason: string): void => {
        if (issues.length >= 1000) return;
        const safeCheck = [...check].length > 128 ? `${[...check].slice(0, 127).join("")}…` : check;
        const safeResourceType = [...resourceType].length > 128 ? `${[...resourceType].slice(0, 127).join("")}…` : resourceType;
        const bounded = [...reason].length > 4096 ? `${[...reason].slice(0, 4095).join("")}…` : reason;
        issues.push({ check: safeCheck, resource_type: safeResourceType, ...(validResourceId(resourceId) ? { resource_id: resourceId } : {}), reason: bounded });
      };
      if (dialect.foreignKeyCheckSql) {
        const foreignKeys = await client.all<Record<string, unknown>>(dialect.foreignKeyCheckSql);
        foreignKeys.forEach((row) => add("foreign_key", asText(row.table), row.rowid === undefined ? undefined : asText(row.rowid), `foreign key references missing ${asText(row.parent)}`));
      }
      // Foreign keys catch missing rows, but they do not express the domain
      // graph invariants that bind every versioned object to its parent
      // aggregate.  Keep these checks in the adapter so `db status` can
      // diagnose direct SQL tampering in both SQLite and MySQL databases.
      const tx = new SqlTx(client, false, metadata.schema_version >= 20, gitArtifactResolver, metadata.schema_version >= 22);
      // All pages share the read transaction above. Every query must have a
      // stable, unique ORDER BY; OFFSET cannot skip concurrent inserts because
      // the transaction retains the same snapshot. Bound page memory and report
      // size, not coverage: a valid large ledger must not fail just for its size.
      const scanRows = async function* <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): AsyncGenerator<T> {
        for (let offset = 0; ; offset += 1000) {
          const rows = await client.all<T>(`${sql} LIMIT 1000 OFFSET ?`, [...params, offset]);
          for (const row of rows) yield row;
          if (rows.length < 1000) return;
        }
      };

      if (metadata.schema_version >= 20) {
        const targets = scanRows<{ issue_revision_id: unknown }>("SELECT issue_revision_id FROM issue_target_branches ORDER BY issue_revision_id");
        for await (const target of targets) {
          try { await tx.getIssueRevisionById(asText(target.issue_revision_id)); }
          catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue; add("issue_target_branch", "issue_revision", asText(target.issue_revision_id), error instanceof Error ? error.message : String(error)); }
        }
      }
      if (metadata.schema_version >= 18) {
        const runtimeRows = scanRows<Record<string, unknown>>("SELECT r.id, r.kind, p.kind AS owner_kind FROM runtime_records r LEFT JOIN runtime_records p ON r.parent_id = p.id ORDER BY r.id");
        for await (const row of runtimeRows) {
          try {
            if (RETIRED_RUNTIME_KINDS.has(asText(row.kind)) || (row.kind === "runtime_operation" && RETIRED_RUNTIME_KINDS.has(asText(row.owner_kind)))) continue;
            const record = await tx.getRuntimeRecord(asText(row.kind), asText(row.id));
            if (!record) throw new Error("Runtime record missing");
            if (isSyncRecord(record)) {
              const sync = syncData(record), run = await tx.getDevRun(sync.dev_run_id);
              if (!run.base_commit) throw new Error("Sync owner is not a target-flow DevRun");
              if (!syncTerminal(sync) && (run.state !== "open" || run.version !== sync.run_version || run.base_commit !== sync.original_base)) throw new Error("Pending sync does not match its DevRun fence");
            }
          } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue; add("runtime_record", asText(row.kind), asText(row.id), error instanceof Error ? error.message : String(error)); }
        }
      }

      // Scan aggregate roots even when they have no descendants.  A query
      // over current revisions alone would make an orphaned Requirement or
      // Issue look healthy simply because its missing graph is invisible to
      // the join.
      const requirementRows = scanRows<Record<string, unknown>>("SELECT id, created_at, attribution_json FROM requirements ORDER BY id");
      for await (const row of requirementRows) {
        const requirementId = asText(row.id);
        try {
          if (!isUUIDv7(requirementId)) throw new Error("Requirement identifier is invalid");
          parseDate(row.created_at);
          parseAttribution(row.attribution_json);
          let hasRevision = false;
          for await (const revision of scanRows<{ id: unknown }>("SELECT id FROM requirement_revisions WHERE requirement_id = ? ORDER BY revision_number, id", [requirementId])) {
            hasRevision = true;
            await tx.getRequirementRevision(requirementId, asText(revision.id));
          }
          if (!hasRevision) throw new Error("Requirement has no RequirementRevision");
        } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue;
          add("requirement_graph", "requirement", requirementId, error instanceof Error ? error.message : String(error));
        }
      }

      const repositoryDigest = dialect.needsRemoteDigest ? ", canonical_remote_digest" : "";
      const repositoryRows = scanRows<Record<string, unknown>>(`SELECT id, canonical_remote${repositoryDigest}, ${dialect.integerText("version")} AS version, created_at, attribution_json FROM repositories ORDER BY id`);
      for await (const row of repositoryRows) {
        const repositoryId = asText(row.id);
        try {
          const repository = await tx.getRepository(repositoryId);
          if (repository.id !== repositoryId || repository.canonical_remote !== asText(row.canonical_remote) || repository.version !== safeInteger(row.version, "version", 1)) throw new Error("Repository projection does not match its stored record");
        } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue;
          add("repository_graph", "repository", repositoryId, error instanceof Error ? error.message : String(error));
        }
      }
      const aliasDigest = dialect.needsRemoteDigest ? ", remote_digest" : "";
      const aliasRows = scanRows<Record<string, unknown>>(`SELECT repository_id, remote, state${aliasDigest} FROM repository_remotes ORDER BY repository_id, remote`);
      for await (const row of aliasRows) {
        const repositoryId = asText(row.repository_id);
        try {
          if (!isUUIDv7(repositoryId)) throw new Error("Repository alias parent identifier is invalid");
          const parent = await client.get<{ id: unknown }>("SELECT id FROM repositories WHERE id = ?", [repositoryId]);
          if (!parent || asText(parent.id) !== repositoryId) throw new Error("Repository alias parent is missing");
          const remote = asText(row.remote);
          validateCanonicalRemote(remote);
          const state = asText(row.state);
          if (state !== "active" && state !== "retired") throw new Error("Repository alias state is invalid");
          if (dialect.needsRemoteDigest && !asDigestBuffer(row.remote_digest).equals(createHash("sha256").update(remote, "utf8").digest())) throw new Error("Repository alias digest is invalid");
        } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue;
          add("repository_alias", "repository", repositoryId, error instanceof Error ? error.message : String(error));
        }
      }

      const issueRootRows = scanRows<{ id: unknown }>("SELECT id FROM issues ORDER BY id");
      for await (const row of issueRootRows) {
        const issueId = asText(row.id);
        try {
          const issue = await tx.getIssue(issueId);
          const requirement = await client.get<{ id: unknown }>("SELECT id FROM requirements WHERE id = ?", [issue.requirement_id]);
          if (!requirement || asText(requirement.id) !== issue.requirement_id) throw new Error("Issue Requirement parent is missing");
          await tx.getRepository(issue.repository_id);
          const revision = await client.get<{ id: unknown }>("SELECT id FROM issue_revisions WHERE issue_id = ? LIMIT 1", [issueId]);
          if (!revision) throw new Error("Issue has no IssueRevision");
        } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue;
          add("issue_graph", "issue", issueId, error instanceof Error ? error.message : String(error));
        }
      }

      const devRunRootRows = scanRows<{ id: unknown }>("SELECT id FROM dev_runs ORDER BY id");
      for await (const row of devRunRootRows) {
        const devRunId = asText(row.id);
        try {
          const run = await tx.getDevRun(devRunId);
          const candidates = await client.all<{ id: unknown; issue_revision_id: unknown; repository_remote_snapshot: unknown }>("SELECT id, issue_revision_id, repository_remote_snapshot FROM candidates WHERE dev_run_id = ? ORDER BY id LIMIT 2", [devRunId]);
          if (run.state === "submitted" && candidates.length !== 1) throw new Error("submitted DevRun must have exactly one Candidate");
          if (run.state !== "submitted" && candidates.length !== 0) throw new Error("non-submitted DevRun must not have a Candidate");
          if (candidates.length === 1 && (asText(candidates[0].issue_revision_id) !== run.issue_revision_id || asText(candidates[0].repository_remote_snapshot) !== run.repository_remote_snapshot)) throw new Error("Candidate does not match its DevRun binding");
        } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue;
          add("dev_run_graph", "dev_run", devRunId, error instanceof Error ? error.message : String(error));
        }
      }

      const deliveryRoots = scanRows<{ id: unknown }>("SELECT id FROM delivery_links ORDER BY id");
      for await (const root of deliveryRoots) {
        const id = asText(root.id);
        try {
          const current = await tx.getDeliveryLink(id);
          const candidate = await tx.getCandidate(current.candidate_id);
          const issue = await tx.getIssueRevisionById(candidate.candidate.issue_revision_id);
          if ((await tx.getIssue(issue.issue_id)).repository_id !== current.repository_id || candidate.candidate.patch_digest !== current.patch_digest) throw new Error("Delivery link Candidate/Repository binding is inconsistent");
          const versions = scanRows<{ version: unknown }>("SELECT version FROM delivery_link_versions WHERE link_id = ? ORDER BY version", [id]);
          const units = indexCandidateChanges(candidate.artifact).change_units;
          for await (const row of versions) {
            const link = await tx.getDeliveryLink(id, safeInteger(row.version, "delivery_link.version", 1));
            if (link.patch_digest !== candidate.candidate.patch_digest) throw new Error("Delivery version artifact binding is inconsistent");
            for (const mapped of link.units) {
              const unit = units.find(u => u.change_unit_id === mapped.change_unit_id);
              if (!unit?.new_range || Buffer.from(unit.path_bytes, "base64").toString("utf8") !== mapped.path || unit.new_range.start !== mapped.candidate_start || unit.new_range.lines !== mapped.lines) throw new Error("Delivery version Change Unit binding is inconsistent");
            }
          }
        } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue;
          add("delivery_link_graph", "delivery_link", id, error instanceof Error ? error.message : String(error));
        }
      }

      const operationRows = scanRows<StoredOperationRow>("SELECT operation_id, command, request_hash, status, result_json, created_at FROM idempotency_records ORDER BY operation_id");
      for await (const row of operationRows) {
        const operationId = asText(row.operation_id);
        try {
          if (!isUUIDv7(operationId)) throw new Error("operation identifier is invalid");
          parseDate(row.created_at);
          const stored = storedOperation(row, operationId);
          if (stored.status === "pending") {
            if (stored.result_json !== null && stored.result_json !== undefined) throw new Error("pending operation contains a result");
          } else {
            if (stored.result_json === null || stored.result_json === undefined) throw new Error("completed operation is missing its result");
            const parsed = parseJSON<unknown>(stored.result_json);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("operation result is not an object");
            const result = parsed as Record<string, unknown>;
            const data = result.format === "patchledger.cli/v1" ? result.data : result;
            if (await isWorkspaceOperationResult(tx, stored.command, operationId, stored.request_hash, result)) continue;
            if (!data || typeof data !== "object" || Array.isArray(data) || typeof (data as Record<string, unknown>).result_type !== "string" || typeof (data as Record<string, unknown>).command !== "string" || (data as Record<string, unknown>).command !== stored.command) throw new Error("operation result command is invalid");
            if (result.format === "patchledger.cli/v1" && (result.ok !== true || !Array.isArray(result.warnings))) throw new Error("operation success envelope is invalid");
          }
        } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue;
          add("idempotency", "database", operationId, error instanceof Error ? error.message : String(error));
        }
      }

      const ledgerRows = scanRows<Record<string, unknown>>(`SELECT ${dialect.integerText("event_seq")} AS event_seq, event_id, event_type, ${dialect.integerText("event_version")} AS event_version, operation_id, repository_id, subject_type, subject_id, ${dialect.integerText("subject_version")} AS subject_version, occurred_at, attribution_json, facts_json FROM ledger_events ORDER BY ledger_events.event_seq`);
      for await (const row of ledgerRows) {
        const eventId = asText(row.event_id);
        try {
          const event = await tx.getLedgerEventForIntegrity(eventId);
          const operationRow = await client.get<StoredOperationRow>("SELECT operation_id, command, request_hash, status, result_json, created_at FROM idempotency_records WHERE operation_id = ?", [event.operation_id]);
          if (!operationRow) throw new Error("LedgerEvent operation is missing");
          const operation = storedOperation(operationRow, event.operation_id);
          if (operation.status !== "completed" || operation.result_json === null || operation.result_json === undefined) throw new Error("LedgerEvent operation is not completed");

          let subjectExists = false;
          let subjectRepositoryId: string | undefined;
          let subjectVersion: number | undefined;
          switch (event.subject_type) {
            case "requirement": {
              const subject = await client.get<{ id: unknown }>("SELECT id FROM requirements WHERE id = ?", [event.subject_id]);
              subjectExists = Boolean(subject && asText(subject.id) === event.subject_id);
              break;
            }
            case "requirement_revision": {
              const subject = await client.get<{ id: unknown; requirement_id: unknown; revision_number: unknown }>(`SELECT rr.id, rr.requirement_id, ${dialect.integerText("rr.revision_number")} AS revision_number FROM requirement_revisions rr JOIN requirements r ON r.id = rr.requirement_id WHERE rr.id = ?`, [event.subject_id]);
              subjectExists = Boolean(subject && asText(subject.id) === event.subject_id);
              if (subject) subjectVersion = safeInteger(subject.revision_number, "subject_version", 1);
              break;
            }
            case "repository": {
              const subject = await client.get<{ id: unknown; version: unknown }>(`SELECT id, ${dialect.integerText("version")} AS version FROM repositories WHERE id = ?`, [event.subject_id]);
              subjectExists = Boolean(subject && asText(subject.id) === event.subject_id);
              // Repository versions advance after move/alias operations; a
              // historical LedgerEvent deliberately retains the version at
              // which it was emitted, so it cannot be compared with the
              // current mutable row.
              if (subject) subjectRepositoryId = event.subject_id;
              break;
            }
            case "issue": {
              const subject = await client.get<{ id: unknown; repository_id: unknown }>("SELECT id, repository_id FROM issues WHERE id = ?", [event.subject_id]);
              subjectExists = Boolean(subject && asText(subject.id) === event.subject_id);
              if (subject) subjectRepositoryId = asText(subject.repository_id);
              break;
            }
            case "issue_revision": {
              const subject = await client.get<{ id: unknown; repository_id: unknown; revision_number: unknown }>(`SELECT ir.id, i.repository_id, ${dialect.integerText("ir.revision_number")} AS revision_number FROM issue_revisions ir JOIN issues i ON i.id = ir.issue_id WHERE ir.id = ?`, [event.subject_id]);
              subjectExists = Boolean(subject && asText(subject.id) === event.subject_id);
              if (subject) { subjectRepositoryId = asText(subject.repository_id); subjectVersion = safeInteger(subject.revision_number, "subject_version", 1); }
              break;
            }
            case "dev_run": {
              const subject = await client.get<{ id: unknown; repository_id: unknown; version: unknown }>(`SELECT d.id, i.repository_id, ${dialect.integerText("d.version")} AS version FROM dev_runs d JOIN issue_revisions ir ON ir.id = d.issue_revision_id JOIN issues i ON i.id = ir.issue_id WHERE d.id = ?`, [event.subject_id]);
              subjectExists = Boolean(subject && asText(subject.id) === event.subject_id);
              // DevRun versions advance when it is submitted or abandoned;
              // the started event's version is historical as well.
              if (subject) subjectRepositoryId = asText(subject.repository_id);
              break;
            }
            case "candidate": {
              const subject = await client.get<{ id: unknown; repository_id: unknown }>(`SELECT c.id, i.repository_id FROM candidates c JOIN issue_revisions ir ON ir.id = c.issue_revision_id JOIN issues i ON i.id = ir.issue_id WHERE c.id = ?`, [event.subject_id]);
              subjectExists = Boolean(subject && asText(subject.id) === event.subject_id);
              if (subject) subjectRepositoryId = asText(subject.repository_id);
              break;
            }
            case "delivery_link": {
              const link = await tx.getDeliveryLink(event.subject_id, event.subject_version);
              subjectExists = true; subjectRepositoryId = link.repository_id; subjectVersion = link.version;
              break;
            }
            case "issue_completion": {
              const subject = await client.get<{ repository_id: unknown }>('SELECT i.repository_id FROM issue_revisions ir JOIN issues i ON i.id = ir.issue_id WHERE ir.id = ?', [event.subject_id]);
              const history = await tx.completionHistory(event.subject_id);
              const record = history.find(record => record.version === event.subject_version);
              subjectExists = Boolean(subject && record);
              if (subject && record) { subjectRepositoryId = asText(subject.repository_id); subjectVersion = record.version;
                if (event.facts.find(f => f.name === 'record_digest')?.value !== sha256(record)) throw new Error('completion audit snapshot mismatch');
              }
              break;
            }
            case "selection": {
              const subject = await client.get<{ id: unknown; repository_id: unknown; version: unknown }>("SELECT s.id, s.version, i.repository_id FROM selections s JOIN issue_revisions ir ON ir.id = s.issue_revision_id JOIN issues i ON i.id = ir.issue_id WHERE s.id = ?", [event.subject_id]);
              subjectExists = Boolean(subject && asText(subject.id) === event.subject_id);
              if (subject) {
                subjectRepositoryId = asText(subject.repository_id);
                if ((event.subject_version ?? 0) > safeInteger(subject.version, "selection.version", 1)) throw new Error("Selection audit version exceeds current version");
              }
              // Historical audit versions deliberately differ from the mutable row.
              break;
            }
            case "verification": {
              const subject = await client.get<{ id: unknown; repository_id: unknown }>(`SELECT v.id, i.repository_id FROM verifications v JOIN candidates c ON c.id = v.candidate_id JOIN issue_revisions ir ON ir.id = c.issue_revision_id JOIN issues i ON i.id = ir.issue_id WHERE v.id = ?`, [event.subject_id]);
              subjectExists = Boolean(subject && asText(subject.id) === event.subject_id);
              if (subject) subjectRepositoryId = asText(subject.repository_id);
              break;
            }
            default:
              if (event.subject_type.startsWith("eval_")) {
                const subject = await tx.getEvalRecord(event.subject_type.slice(5) as EvalKind, event.subject_id, event.subject_version);
                if (["envcheck", "preparation", "instance"].includes(subject.kind)) {
                  for (const file of (subject.data as import("./eval-environment.js").EnvironmentCheck).files) if ((await tx.getEvalBlob(file.digest)).length !== file.size) throw new Error("Environment evidence size mismatch");
                }
                if (subject.kind === "artifact") {
                  const artifact = await tx.getEvalRecord("artifact", subject.id);
                  const run = await tx.getEvalRecord("run", artifact.data.run_id);
                  if (run.data.artifact_id !== artifact.id || run.data.task.qa?.id !== artifact.data.qa.id || run.data.task.qa.version !== artifact.data.qa.version) throw new Error("QA artifact binding is invalid");
                  await tx.getEvalRecord("qa", artifact.data.qa.id, artifact.data.qa.version);
                  for (const file of artifact.data.files) if ((await tx.getEvalBlob(file.digest)).length !== file.size) throw new Error("QA evidence size mismatch");
                }
                if (subject.kind === "execution") {
                  const execution = await tx.getEvalRecord("execution", subject.id, subject.version);
                  for (const file of execution.data.grading_evidence?.files ?? []) if ((await tx.getEvalBlob(file.digest)).length !== file.size) throw new Error("QA grading evidence size mismatch");
                }
                subjectExists = true;
                subjectVersion = subject.version;
                if (!event.facts.some(f => f.name === "record_digest" && f.value === sha256(subject))) throw new Error("Eval audit digest does not match its revision");
              } else throw new Error("LedgerEvent subject type is invalid");
          }
          if (!subjectExists) throw new Error("LedgerEvent subject is missing");
          if (subjectRepositoryId !== undefined && event.repository_id !== subjectRepositoryId) throw new Error("LedgerEvent repository binding does not match its subject");
          if (subjectVersion !== undefined && event.subject_version !== subjectVersion) throw new Error("LedgerEvent subject version does not match its subject");
        } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue;
          add("ledger_graph", "database", eventId, error instanceof Error ? error.message : String(error));
        }
      }

      const issueRows = scanRows<{ id: unknown }>("SELECT id FROM issue_revisions ORDER BY id");
      for await (const row of issueRows) {
        const revisionId = asText(row.id);
        try {
          const revision = await tx.getIssueRevisionById(revisionId);
          const issue = await tx.getIssue(revision.issue_id);
          if (revision.requirement_id !== issue.requirement_id) add("issue_revision_binding", "issue_revision", revisionId, "IssueRevision requirement does not match its Issue");
          const requirement = await tx.getRequirementRevision(issue.requirement_id, revision.requirement_revision_id);
          if (requirement.requirement_id !== issue.requirement_id) add("issue_revision_binding", "issue_revision", revisionId, "IssueRevision RequirementRevision belongs to another Requirement");
          try { validateBaseline(revision.baseline); } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue; add("baseline", "issue_revision", revisionId, error instanceof Error ? error.message : String(error)); }
          if (revision.goals.length === 0) add("target_coverage", "issue_revision", revisionId, "IssueRevision has no Goal");
          const seenTargets = new Set<string>();
          for (const goal of revision.goals) {
            const key = `goal:${goal.id}`;
            if (seenTargets.has(key)) add("target_coverage", "issue_revision", revisionId, `duplicate Goal ID ${goal.id}`);
            seenTargets.add(key);
          }
          for (const goal of revision.goals) if (goal.criteria.length === 0) add("criterion_coverage", "goal", goal.id, "Goal has no Criterion");
          for (const constraint of revision.constraints) {
            const key = `constraint:${constraint.id}`;
            if (seenTargets.has(key)) add("target_coverage", "issue_revision", revisionId, `duplicate Constraint ID ${constraint.id}`);
            seenTargets.add(key);
            if (constraint.criteria.length === 0) add("criterion_coverage", "constraint", constraint.id, "Constraint has no Criterion");
          }
          const orphanCriteria = scanRows<{ id: unknown; target_type: unknown; target_id: unknown }>("SELECT c.id, c.target_type, c.target_id FROM criteria c WHERE c.issue_revision_id = ? AND NOT EXISTS (SELECT 1 FROM goals g WHERE g.issue_revision_id = c.issue_revision_id AND c.target_type = 'goal' AND g.id = c.target_id) AND NOT EXISTS (SELECT 1 FROM constraints k WHERE k.issue_revision_id = c.issue_revision_id AND c.target_type = 'constraint' AND k.id = c.target_id) ORDER BY c.id", [revisionId]);
          for await (const criterion of orphanCriteria) add("criterion_binding", "criterion", asText(criterion.id), `Criterion references an unknown ${asText(criterion.target_type)} ${asText(criterion.target_id)}`);
          const orphanGuidance = scanRows<{ target_type: unknown; target_id: unknown }>("SELECT g.target_type, g.target_id FROM target_guidance g WHERE g.issue_revision_id = ? AND NOT EXISTS (SELECT 1 FROM goals o WHERE o.issue_revision_id = g.issue_revision_id AND g.target_type = 'goal' AND o.id = g.target_id) AND NOT EXISTS (SELECT 1 FROM constraints k WHERE k.issue_revision_id = g.issue_revision_id AND g.target_type = 'constraint' AND k.id = g.target_id) ORDER BY g.target_id, g.ordinal", [revisionId]);
          for await (const guidance of orphanGuidance) add("guidance_binding", asText(guidance.target_type), asText(guidance.target_id), "Guidance references an unknown IssueRevision target");
        } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue;
          add("issue_revision", "issue_revision", revisionId, error instanceof Error ? error.message : String(error));
        }
      }

      if (metadata.schema_version >= 22) {
        for await (const row of scanRows<{ candidate_id: unknown }>("SELECT candidate_id FROM candidate_git_artifacts ORDER BY candidate_id")) {
          const candidateId = asText(row.candidate_id);
          try {
            const ref = await tx.findCandidateArtifactRef({ candidate_id: candidateId });
            if (!ref?.git_artifact) throw new Error("Git artifact metadata references a missing Candidate");
          } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue; add("candidate_git_artifact", "candidate", candidateId, error instanceof Error ? error.message : String(error)); }
        }
      }

      const candidateRows = scanRows<{ id: unknown }>("SELECT id FROM candidates ORDER BY id");
      for await (const row of candidateRows) {
        const candidateId = asText(row.id);
        try {
          const record = await tx.getCandidate(candidateId);
          const revision = await tx.getIssueRevisionById(record.candidate.issue_revision_id);
          const issue = await tx.getIssue(revision.issue_id);
          if (record.candidate.issue_revision_id !== revision.id || revision.issue_id !== issue.id || revision.requirement_id !== issue.requirement_id) add("candidate_binding", "candidate", candidateId, "Candidate, Issue and IssueRevision references do not agree");
          const patch = record.artifact.patch;
          validatePersistedCandidateArtifact(record.candidate, { ...record.artifact, patch }, patch);
          const expected = new Map<string, Set<string>>();
          for (const goal of revision.goals) expected.set(`goal:${goal.id}`, new Set(goal.criteria.map((criterion) => criterion.id)));
          for (const constraint of revision.constraints) expected.set(`constraint:${constraint.id}`, new Set(constraint.criteria.map((criterion) => criterion.id)));
          const claims = record.candidate.submission.claims;
          const seen = new Set<string>();
          for (const claim of claims) {
            const key = `${claim.target_type}:${claim.target_id}`;
            const criteria = expected.get(key);
            if (!criteria || seen.has(key)) { add("claim_coverage", "candidate", candidateId, "Candidate claim target is unknown or duplicated"); continue; }
            seen.add(key);
            const actual = new Set(claim.criteria.map((criterion) => criterion.criterion_id));
            if (actual.size !== criteria.size || [...criteria].some((id) => !actual.has(id))) add("claim_coverage", "candidate", candidateId, "Candidate claim does not cover every sealed Criterion");
          }
          if (seen.size !== expected.size) add("claim_coverage", "candidate", candidateId, "Candidate claims do not cover every sealed target");
          if (record.refines_candidate_id) {
            const parent = await tx.getCandidate(record.refines_candidate_id);
            if (parent.candidate.issue_revision_id !== record.candidate.issue_revision_id) add("refinement", "candidate", candidateId, "refinement parent belongs to another IssueRevision");
          }
        } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue;
          add("candidate", "candidate", candidateId, error instanceof Error ? error.message : String(error));
        }
      }

      const verificationRows = scanRows<{ id: unknown }>("SELECT id FROM verifications ORDER BY id");
      for await (const row of verificationRows) {
        const verificationId = asText(row.id);
        try {
          const record = await tx.getVerification(verificationId);
          const candidate = await tx.getCandidate(record.verification.candidate_id);
          if (record.verification.result_tree_oid !== candidate.candidate.result_tree_oid || record.verification.blind_context_digest !== candidate.candidate.blind_context_digest) add("verification_binding", "verification", verificationId, "Verification does not match the immutable Candidate tree or blind digest");
          let reportValid = true;
          try { validateVerificationReport(record.report); } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue; reportValid = false; add("verification_report", "verification", verificationId, error instanceof Error ? error.message : String(error)); }
          if (reportValid && record.verification.overall_verdict !== combinedVerdict(record.report, record.quality?.report)) add("verification_verdict", "verification", verificationId, "stored overall verdict does not match the final criterion verdicts");
          const revision = await tx.getIssueRevisionById(candidate.candidate.issue_revision_id);
          const expected = new Set<string>();
          for (const goal of revision.goals) for (const criterion of goal.criteria) expected.add(`goal:${goal.id}:${criterion.id}`);
          for (const constraint of revision.constraints) for (const criterion of constraint.criteria) expected.add(`constraint:${constraint.id}:${criterion.id}`);
          const actual = new Set<string>();
          for (const assessment of record.report.assessments) for (const criterion of assessment.criteria) actual.add(`${assessment.target_type}:${assessment.target_id}:${criterion.criterion_id}`);
          if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) add("verification_coverage", "verification", verificationId, "Verification does not cover every sealed Criterion");
        } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue;
          add("verification", "verification", verificationId, error instanceof Error ? error.message : String(error));
        }
      }

      const frozenRows = scanRows<{ dev_run_id: unknown; verification_id: unknown; ordinal: unknown }>("SELECT dev_run_id, verification_id, ordinal FROM dev_run_refinement_verifications ORDER BY dev_run_id, ordinal");
      let frozenRunId = "";
      let frozenOrdinal = 0;
      for await (const row of frozenRows) {
        const devRunId = asText(row.dev_run_id);
        const verificationId = asText(row.verification_id);
        try {
          if (!isUUIDv7(devRunId) || !isUUIDv7(verificationId)) throw new Error("frozen refinement identifiers are invalid");
          if (devRunId !== frozenRunId) { frozenRunId = devRunId; frozenOrdinal = 0; }
          if (safeInteger(row.ordinal, "refinement_verification.ordinal") !== frozenOrdinal) throw new Error("frozen refinement Verification ordinals are not contiguous");
          frozenOrdinal += 1;
          const run = await tx.getDevRun(devRunId);
          if (!run.refines_candidate_id) throw new Error("non-refinement DevRun has frozen Verifications");
          const summary = await tx.getVerificationSummary(verificationId);
          if (summary.candidate_id !== run.refines_candidate_id) throw new Error("frozen Verification belongs to another Candidate");
        } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue;
          add("refinement", "dev_run", devRunId, error instanceof Error ? error.message : String(error));
        }
      }

      const refinementRows = scanRows<{ dev_run_id: unknown; issue_revision_id: unknown; candidate_issue_revision_id: unknown; candidate_id: unknown }>("SELECT d.id AS dev_run_id, d.issue_revision_id, c.issue_revision_id AS candidate_issue_revision_id, c.id AS candidate_id FROM dev_runs d JOIN candidates c ON c.id = d.refines_candidate_id WHERE d.refines_candidate_id IS NOT NULL ORDER BY d.id");
      for await (const row of refinementRows) {
        const devRunId = asText(row.dev_run_id);
        if (asText(row.issue_revision_id) !== asText(row.candidate_issue_revision_id)) add("refinement", "dev_run", devRunId, "refinement parent belongs to another IssueRevision");
        const frozen = await tx.listDevRunRefinementVerifications(devRunId);
        for (const verificationId of frozen) {
          try {
            const summary = await tx.getVerificationSummary(verificationId);
            if (summary.candidate_id !== asText(row.candidate_id)) add("refinement", "dev_run", devRunId, "frozen Verification belongs to another Candidate");
          } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue; add("refinement", "dev_run", devRunId, error instanceof Error ? error.message : String(error)); }
        }
      }

      if (metadata.schema_version >= 23) {
        const completions = scanRows<{ issue_revision_id: unknown }>('SELECT DISTINCT issue_revision_id FROM issue_completion_versions ORDER BY issue_revision_id');
        for await (const row of completions) {
          const revisionId = asText(row.issue_revision_id);
          try {
            const revision = await tx.getIssueRevisionById(revisionId);
            const issue = await tx.getIssue(revision.issue_id);
            const history = await tx.completionHistory(revisionId);
            for (const record of history) {
              if (record.completion.repository_id !== issue.repository_id || (revision.target_branch && record.completion.target_branch !== revision.target_branch.ref)) throw new Error('completion scope differs from Issue');
              if (record.completion.candidate_id && (await tx.getCandidate(record.completion.candidate_id)).candidate.issue_revision_id !== revisionId) throw new Error('completion Candidate belongs to another Issue Version');
            }
          } catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue; add('completion_binding', 'issue_completion', revisionId, error instanceof Error ? error.message : String(error)); }
        }
      }

      const selectionRows = scanRows<{ issue_revision_id: unknown }>("SELECT issue_revision_id FROM selections ORDER BY id");
      for await (const row of selectionRows) {
        try { await tx.getSelection(asText(row.issue_revision_id)); }
        catch (error) { if (error instanceof DomainError && error.code === "UNSUPPORTED_CANDIDATE_ARTIFACT") continue; add("selection_binding", "selection", undefined, error instanceof Error ? error.message : String(error)); }
      }

      // Legacy artifact_blobs/chunks remain historical data; this version never decodes them.
      await client.commit();
      return { metadata, report: { valid: issues.length === 0, issues } };
};
