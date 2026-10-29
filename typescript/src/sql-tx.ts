






import {resolve} from "node:path";

import {isUUIDv7} from "./identity.js";
import {sha256Bytes} from "./canonical-json.js";
import {DomainError, notFound, validation, versionConflict} from "./errors.js";








import {type Candidate, type DevRun, type IssueRevision, type RequirementRevision, type Verification} from "./domain.js";

import type {CandidateListFilter, CandidateListItem, CandidateVerificationCounts, DevRunListFilter, DevRunListItem, IssueListFilter, IssueListItem, ListPageKey, LedgerEvent, RepositoryRecord, RequirementAggregateFacts, RequirementListItem, VerificationListFilter, VerificationSummaryItem} from "./store-types.js";

export const PROTOCOL_VERSION = 1;
export const REMOTE_NORMALIZATION_VERSION = 1;
export const MINIMUM_CLI_VERSION = "0.1.0";
const CLI_VERSION = "0.1.0";
import {asText, asOptionalText, asBuffer, validResourceId, requireRow, parseAttribution, storedLedgerFacts, parseDate, safeInteger, persistedRecordError, validateContiguousOrdinals} from "./sql-shared.js";

import type { ReadTx, Tx } from "./store-types.js";
import { SqlTxWork } from "./sql-tx-work.js";

import { standingFromCounts } from "./sql-shared.js";

// Latest explicit record wins; Selection and Delivery Link never imply completion.
const completedSQL = (revision: string): string => `EXISTS (SELECT 1 FROM issue_completion_versions ic WHERE ic.issue_revision_id = ${revision} AND ic.state = 'completed' AND NOT EXISTS (SELECT 1 FROM issue_completion_versions newer WHERE newer.issue_revision_id = ic.issue_revision_id AND newer.version > ic.version))`;

export class SqlTx extends SqlTxWork implements Tx, ReadTx {
  async listRequirements(): Promise<RequirementListItem[]> {
    const page = await this.listRequirementsPage("", 10000);
    if (page.more) throw new DomainError("ARTIFACT_TOO_LARGE", "Requirement list exceeds 10,000 resources");
    return page.rows;
  }

  async listRequirementsPage(afterId: string, limit: number): Promise<{ rows: RequirementListItem[]; more: boolean }> {
    if (!Number.isInteger(limit) || limit < 1) throw validation("limit", "must be at least 1");
    const after = afterId ? " AND r.id > ?" : "";
    // Progress uses the same population as `requirement show`: Issue and ready
    // counts follow current Issue Versions, while open DevRun and Candidate
    // counts cover every Issue Version that belongs to the Requirement.
    const current = "NOT EXISTS (SELECT 1 FROM issue_revisions successor WHERE successor.predecessor_revision_id = cir.id)";
    const rows = await this.client.all<Record<string, unknown>>(`SELECT r.id, rr.id AS revision_id, rr.summary, ${this.integerText("rr.revision_number")} AS revision_number,
      ${this.integerText(`(SELECT count(*) FROM issues ci JOIN issue_revisions cir ON cir.issue_id = ci.id WHERE ci.requirement_id = r.id AND ${current})`)} AS issue_count,
      ${this.integerText(`(SELECT count(*) FROM issues ci JOIN issue_revisions cir ON cir.issue_id = ci.id WHERE ci.requirement_id = r.id AND ${current}
        AND NOT ${completedSQL("cir.id")}
        AND NOT EXISTS (SELECT 1 FROM candidates cc WHERE cc.issue_revision_id = cir.id)
        AND NOT EXISTS (SELECT 1 FROM dev_runs cd WHERE cd.issue_revision_id = cir.id AND cd.state = 'open')
        AND NOT EXISTS (SELECT 1 FROM selections cs WHERE cs.issue_revision_id = cir.id AND cs.candidate_id IS NOT NULL))`)} AS ready_issue_count,
      ${this.integerText("(SELECT count(*) FROM dev_runs od JOIN issue_revisions oir ON oir.id = od.issue_revision_id JOIN issues oi ON oi.id = oir.issue_id WHERE oi.requirement_id = r.id AND od.state = 'open')")} AS open_dev_run_count,
      ${this.integerText("(SELECT count(*) FROM candidates xc JOIN issue_revisions xir ON xir.id = xc.issue_revision_id JOIN issues xi ON xi.id = xir.issue_id WHERE xi.requirement_id = r.id)")} AS candidate_count
      , ${this.integerText(`(SELECT count(*) FROM issues ci JOIN issue_revisions cir ON cir.issue_id = ci.id WHERE ci.requirement_id = r.id AND cir.requirement_revision_id = rr.id AND ${current})`)} AS bound_count
      , ${this.integerText(`(SELECT count(*) FROM issues ci JOIN issue_revisions cir ON cir.issue_id = ci.id WHERE ci.requirement_id = r.id AND cir.requirement_revision_id = rr.id AND ${current} AND ${completedSQL('cir.id')})`)} AS completed_count
      FROM requirements r JOIN requirement_revisions rr ON rr.requirement_id = r.id WHERE NOT EXISTS (SELECT 1 FROM requirement_revisions successor WHERE successor.predecessor_revision_id = rr.id)${after} ORDER BY r.id LIMIT ?`, afterId ? [afterId, limit + 1] : [limit + 1]);
    const result: RequirementListItem[] = [];
    for (const row of rows.slice(0, limit)) {
      const requirementId = asText(row.id);
      const revisionId = asText(row.revision_id);
      try {
        if (!isUUIDv7(requirementId) || !isUUIDv7(revisionId)) throw new Error("Requirement list identifiers are invalid");
        const storedRevisionNumber = safeInteger(row.revision_number, "revision_number", 1);
        const revision = await this.getRequirementRevision(requirementId, revisionId);
        if (revision.requirement_id !== requirementId || revision.id !== revisionId || revision.revision_number !== storedRevisionNumber || revision.summary !== asText(row.summary)) throw new Error("Requirement list projection does not match its stored RequirementRevision");
        const issueCount = safeInteger(row.issue_count, "issue_count");
        const readyCount = safeInteger(row.ready_issue_count, "ready_issue_count");
        if (readyCount > issueCount) throw new Error("Requirement ready Issue count exceeds its Issue count");
        result.push({ id: requirementId, summary: revision.summary, revision_number: revision.revision_number, issue_count: issueCount, bound_count: safeInteger(row.bound_count, "bound_count"), completed_count: safeInteger(row.completed_count, "completed_count"), ready_issue_count: readyCount, open_dev_run_count: safeInteger(row.open_dev_run_count, "open_dev_run_count"), candidate_count: safeInteger(row.candidate_count, "candidate_count") });
      } catch (error) {
        return persistedRecordError("requirement", requirementId, "stored Requirement list entry is invalid", error);
      }
    }
    return { rows: result, more: rows.length > limit };
  }

  async listRepositories(): Promise<RepositoryRecord[]> {
    const page = await this.listRepositoriesPage("", 10000);
    if (page.more) throw new DomainError("ARTIFACT_TOO_LARGE", "Repository list exceeds 10,000 resources");
    return page.rows;
  }

  /** Repository mutations live here (not the core module) to keep that module
   * within its size budget.  Each consults the transport-agnostic match key so a
   * new remote cannot manufacture an ambiguous host-and-path match. */
  async moveRepository(repositoryId: string, remote: string, expectedVersion: number): Promise<RepositoryRecord> {
    const current = await this.getRepository(repositoryId);
    if (current.version !== expectedVersion) throw versionConflict("repository", repositoryId, expectedVersion, current.version);
    if (current.canonical_remote === remote) throw validation("canonical_remote", "must differ from the current canonical remote");
    const ownerSql = `SELECT repository_id FROM repository_remotes WHERE ${this.remoteWhere()}`;
    const owner = await this.client.get<{ repository_id: unknown }>(ownerSql, this.remoteParams(remote));
    if (owner && asText(owner.repository_id) !== repositoryId) throw validation("canonical_remote", "is already assigned to another Repository");
    await this.assertNoForeignKeyConflict(repositoryId, remote, "canonical_remote");
    const result = this.remoteIndexed
      ? await this.client.run("UPDATE repositories SET canonical_remote = ?, canonical_remote_digest = ?, version = version + 1 WHERE id = ? AND version = ?", [remote, this.remoteDigest(remote), repositoryId, expectedVersion])
      : await this.client.run("UPDATE repositories SET canonical_remote = ?, version = version + 1 WHERE id = ? AND version = ?", [remote, repositoryId, expectedVersion]);
    if (result.changes !== 1) throw versionConflict("repository", repositoryId, expectedVersion, current.version);
    if (owner) {
      if (this.remoteIndexed) await this.client.run("UPDATE repository_remotes SET state = 'active', remote = ? WHERE repository_id = ? AND remote_digest = ? AND remote = ?", [remote, repositoryId, this.remoteDigest(remote), remote]);
      else await this.client.run("UPDATE repository_remotes SET state = 'active' WHERE repository_id = ? AND remote = ?", [repositoryId, remote]);
    } else await this.insertRemote(repositoryId, remote, "active");
    return { ...current, canonical_remote: remote, version: current.version + 1 };
  }

  async addRepositoryAlias(repositoryId: string, remote: string, expectedVersion: number): Promise<RepositoryRecord> {
    const current = await this.getRepository(repositoryId);
    if (current.version !== expectedVersion) throw versionConflict("repository", repositoryId, expectedVersion, current.version);
    if (current.canonical_remote === remote) throw validation("remote", "is already the canonical remote");
    const sql = `SELECT repository_id, state FROM repository_remotes WHERE ${this.remoteWhere()}`;
    const existing = await this.client.get<{ repository_id: unknown; state: unknown }>(sql, this.remoteParams(remote));
    if (existing && asText(existing.repository_id) !== repositoryId) throw validation("remote", "is already assigned to another Repository");
    if (existing && asText(existing.state) === "active") throw validation("remote", "is already an active alias");
    await this.assertNoForeignKeyConflict(repositoryId, remote, "remote");
    if (existing) {
      if (this.remoteIndexed) await this.client.run("UPDATE repository_remotes SET state = 'active' WHERE repository_id = ? AND remote_digest = ? AND remote = ?", [repositoryId, this.remoteDigest(remote), remote]);
      else await this.client.run("UPDATE repository_remotes SET state = 'active' WHERE repository_id = ? AND remote = ?", [repositoryId, remote]);
    } else await this.insertRemote(repositoryId, remote, "active");
    const result = await this.client.run("UPDATE repositories SET version = version + 1 WHERE id = ? AND version = ?", [repositoryId, expectedVersion]);
    if (result.changes !== 1) throw versionConflict("repository", repositoryId, expectedVersion, current.version);
    return { ...current, version: current.version + 1 };
  }

  async retireRepositoryAlias(repositoryId: string, remote: string, expectedVersion: number): Promise<RepositoryRecord> {
    const current = await this.getRepository(repositoryId);
    if (current.version !== expectedVersion) throw versionConflict("repository", repositoryId, expectedVersion, current.version);
    if (current.canonical_remote === remote) throw validation("remote", "the canonical remote cannot be retired");
    // A digest is only an index.  Keep the canonical remote in the predicate
    // as well so a corrupted/colliding digest cannot retire a different alias.
    const sql = this.remoteIndexed
      ? "SELECT state FROM repository_remotes WHERE repository_id = ? AND remote_digest = ? AND remote = ?"
      : "SELECT state FROM repository_remotes WHERE repository_id = ? AND remote = ?";
    const existing = await this.client.get<{ state: unknown }>(sql, this.remoteIndexed ? [repositoryId, this.remoteDigest(remote), remote] : [repositoryId, remote]);
    if (!existing) throw notFound("repository", repositoryId);
    if (asText(existing.state) !== "active") throw validation("remote", "is already retired");
    if (this.remoteIndexed) await this.client.run("UPDATE repository_remotes SET state = 'retired' WHERE repository_id = ? AND remote_digest = ? AND remote = ? AND state = 'active'", [repositoryId, this.remoteDigest(remote), remote]);
    else await this.client.run("UPDATE repository_remotes SET state = 'retired' WHERE repository_id = ? AND remote = ? AND state = 'active'", [repositoryId, remote]);
    const result = await this.client.run("UPDATE repositories SET version = version + 1 WHERE id = ? AND version = ?", [repositoryId, expectedVersion]);
    if (result.changes !== 1) throw versionConflict("repository", repositoryId, expectedVersion, current.version);
    return { ...current, version: current.version + 1 };
  }

  async listRepositoriesPage(afterId: string, limit: number): Promise<{ rows: RepositoryRecord[]; more: boolean }> {
    if (!Number.isInteger(limit) || limit < 1) throw validation("limit", "must be at least 1");
    const digest = this.client.dialect.remoteDigestExpression("canonical_remote_digest");
    const args: unknown[] = [];
    let where = "";
    if (afterId) { where = " WHERE id > ?"; args.push(afterId); }
    args.push(limit + 1);
    const rows = await this.client.all<Record<string, unknown>>(`SELECT id, canonical_remote, ${digest} AS canonical_remote_digest, ${this.integerText("version")} AS version, created_at, attribution_json FROM repositories${where} ORDER BY id LIMIT ?`, args);
    const result: RepositoryRecord[] = [];
    for (const row of rows.slice(0, limit)) {
      const resourceId = asText(row.id);
      try {
        const repository = this.repositoryFromRow(row);
        await this.validateRepositoryRemoteBinding(repository);
        result.push(repository);
      } catch (error) {
        return persistedRecordError("repository", resourceId, "stored Repository is invalid", error);
      }
    }
    return { rows: result, more: rows.length > limit };
  }

  async listIssues(requirementId: string, filter: IssueListFilter = {}): Promise<IssueListItem[]> {
    const page = await this.listIssuesPage(requirementId, "", 10000, filter);
    if (page.more) throw new DomainError("ARTIFACT_TOO_LARGE", "Issue list exceeds 10,000 resources");
    await this.attachIssueActivity(page.rows);
    return page.rows;
  }

  async attachIssueActivity(items: IssueListItem[]): Promise<void> {
    for (const item of items) {
      // Same-instant ties resolve to the later lifecycle step (kind_rank).
      // Business activity is ledger-provable work on the Issue: publication,
      // DevRun start/abandon, Candidate, Verification and Selection changes.
      const rows = await this.client.all<Record<string, unknown>>(`
        SELECT occurred_at, kind, issue_version FROM (
          ${this.issueActivityUnion("ir.issue_id = ?")}
        ) activity ORDER BY activity_key DESC, kind_rank DESC, issue_version DESC LIMIT 1`, [item.id, item.id, item.id, item.id, item.id, item.id, item.id]);
      if (rows[0]) item.last_activity = { occurred_at: parseDate(rows[0].occurred_at), kind: asText(rows[0].kind), issue_version: safeInteger(rows[0].issue_version, "issue_version", 1) };
    }
  }

  // Stored timestamps are canonical RFC3339Nano with trailing fraction zeros
  // removed, so "…:05.5Z" would sort after "…:05.51Z" as plain text.  Order and
  // compare through a fixed-width key (seconds plus nine fraction digits).
  protected timeKey(column: string): string {
    return this.client.dialect.timeKey(column);
  }

  // One SELECT per activity source.  `scope` restricts every source to one
  // Issue (a single `?` per source) or is "1 = 1" for the grouped sort key.
  protected issueActivityUnion(scope: string): string {
    const src = (time: string, kind: string, rank: number, from: string, where: string): string => `SELECT ${time} AS occurred_at, ${this.timeKey(time)} AS activity_key, '${kind}' AS kind, ${rank} AS kind_rank, ir.revision_number AS issue_version, ir.issue_id AS activity_issue_id FROM ${from} WHERE ${where}`;
    return [
      src("ir.created_at", "published", 0, "issue_revisions ir", scope),
      src("d.created_at", "devrun_started", 1, "dev_runs d JOIN issue_revisions ir ON ir.id = d.issue_revision_id", scope),
      src("e.occurred_at", "devrun_abandoned", 2, "ledger_events e JOIN dev_runs d ON d.id = e.subject_id JOIN issue_revisions ir ON ir.id = d.issue_revision_id", `e.event_type = 'devrun.abandoned' AND e.subject_type = 'dev_run' AND ${scope}`),
      src("c.created_at", "candidate", 3, "candidates c JOIN issue_revisions ir ON ir.id = c.issue_revision_id", scope),
      src("v.created_at", "verification", 4, "verifications v JOIN candidates c ON c.id = v.candidate_id JOIN issue_revisions ir ON ir.id = c.issue_revision_id", scope),
      src("e.occurred_at", "completion", 6, "ledger_events e JOIN issue_revisions ir ON ir.id = e.subject_id", `e.subject_type = 'issue_completion' AND ${scope}`),
      src("s.updated_at", "selection", 5, "selections s JOIN issue_revisions ir ON ir.id = s.issue_revision_id", scope),
    ].join("\n          UNION ALL ");
  }

  async listIssuesPage(requirementId: string, after: string | ListPageKey, limit: number, filter: IssueListFilter = {}): Promise<{ rows: IssueListItem[]; more: boolean }> {
    if (!Number.isInteger(limit) || limit < 1) throw validation("issue_limit", "must be at least 1");
    const byActivity = filter.sort === "activity";
    if (byActivity ? typeof after === "string" && after : typeof after !== "string") throw validation("after", "does not match the list ordering");
    const open = "(SELECT count(*) FROM dev_runs od WHERE od.issue_revision_id = ir.id AND od.state = 'open')";
    const candidates = "(SELECT count(*) FROM candidates cc WHERE cc.issue_revision_id = ir.id)";
    const completed = completedSQL("ir.id");
    const selected = "EXISTS (SELECT 1 FROM selections cs WHERE cs.issue_revision_id = ir.id AND cs.candidate_id IS NOT NULL)";
    const args: unknown[] = [];
    let where = "WHERE NOT EXISTS (SELECT 1 FROM issue_revisions successor WHERE successor.predecessor_revision_id = ir.id)";
    if (requirementId) { where += " AND i.requirement_id = ?"; args.push(requirementId); }
    if (filter.repository_id) { where += " AND i.repository_id = ?"; args.push(filter.repository_id); }
    if (typeof after === "string") { if (after) { where += " AND i.id > ?"; args.push(after); } }
    else { where += " AND (act.last_at < ? OR (act.last_at = ? AND i.id > ?))"; args.push(after.key, after.key, after.id); }
    if (filter.has_open_dev_run !== undefined) where += ` AND ${open} ${filter.has_open_dev_run ? ">" : "="} 0`;
    if (filter.status === "completed") where += ` AND ${completed}`;
    else if (filter.status) where += ` AND NOT ${completed}`;
    if (filter.status === "candidate_selected") where += ` AND ${selected}`;
    else if (filter.status === "candidates_available") where += ` AND NOT ${selected} AND ${candidates} > 0`;
    else if (filter.status === "exploring") where += ` AND NOT ${selected} AND ${candidates} = 0 AND ${open} > 0`;
    else if (filter.status === "ready") where += ` AND NOT ${selected} AND ${candidates} = 0 AND ${open} = 0`;
    const join = byActivity ? `LEFT JOIN (SELECT activity_issue_id, MAX(activity_key) AS last_at FROM (${this.issueActivityUnion("1 = 1")}) grouped_activity GROUP BY activity_issue_id) act ON act.activity_issue_id = i.id` : "";
    const order = byActivity ? "ORDER BY act.last_at DESC, i.id" : "ORDER BY i.id";
    args.push(limit + 1);
    const rows = await this.client.all<Record<string, unknown>>(`SELECT i.id, ir.id AS issue_revision_id, ir.summary, ${this.integerText("ir.revision_number")} AS revision_number, i.requirement_id, ir.requirement_revision_id, ${this.integerText("rr.revision_number")} AS requirement_version, i.repository_id, ir.baseline_oid, ir.baseline_reachability, ir.baseline_warning, ir.baseline_override_reason, ${byActivity ? "act.last_at" : "''"} AS order_key, ${this.integerText(open)} AS open_dev_run_count, ${this.integerText(candidates)} AS candidate_count, ${this.integerText(`CASE WHEN ${selected} THEN 1 ELSE 0 END`)} AS selected FROM issues i JOIN issue_revisions ir ON ir.issue_id = i.id JOIN requirement_revisions rr ON rr.id = ir.requirement_revision_id ${join} ${where} ${order} LIMIT ?`, args);
    const items: IssueListItem[] = [];
    const repositories = new Map<string, RepositoryRecord>();
    for (const row of rows) {
      const issueId = asText(row.id);
      try {
        const revisionId = asText(row.issue_revision_id);
        const storedRevisionNumber = safeInteger(row.revision_number, "revision_number", 1);
        if (!isUUIDv7(issueId) || !isUUIDv7(revisionId)) throw new Error("Issue list identifiers are invalid");
        const issue = await this.getIssue(issueId);
        const revision = await this.getIssueRevision(issueId, revisionId);
        let repository = repositories.get(issue.repository_id);
        if (!repository) { repository = await this.getRepository(issue.repository_id); repositories.set(repository.id, repository); }
        const requirementRevision = await this.getRequirementRevision(issue.requirement_id, revision.requirement_revision_id);
        if (issue.requirement_id !== asText(row.requirement_id) || issue.repository_id !== asText(row.repository_id) || revision.issue_id !== issueId || revision.requirement_id !== issue.requirement_id || revision.requirement_revision_id !== asText(row.requirement_revision_id) || requirementRevision.revision_number !== safeInteger(row.requirement_version, "requirement_version", 1) || revision.revision_number !== storedRevisionNumber || revision.summary !== asText(row.summary) || revision.baseline.git_oid !== asText(row.baseline_oid) || revision.baseline.reachability !== asText(row.baseline_reachability) || revision.baseline.warning !== asOptionalText(row.baseline_warning) || revision.baseline.override_reason !== asOptionalText(row.baseline_override_reason)) {
          throw new Error("Issue list projection does not match its stored Issue or IssueRevision");
        }
        items.push({ id: issue.id, issue_revision_id: revision.id, summary: revision.summary, revision_number: revision.revision_number, requirement_id: issue.requirement_id, requirement_revision_id: revision.requirement_revision_id, requirement_version: requirementRevision.revision_number, repository_id: issue.repository_id, canonical_remote: repository.canonical_remote, baseline: revision.baseline, open_dev_run_count: safeInteger(row.open_dev_run_count, "open_dev_run_count"), candidate_count: safeInteger(row.candidate_count, "candidate_count"), selected: safeInteger(row.selected, "selected") === 1, ...(byActivity ? { order_key: asText(row.order_key) } : {}) });
      } catch (error) {
        return persistedRecordError("issue", issueId, "stored Issue list entry is invalid", error);
      }
    }
    return { rows: items.slice(0, limit), more: items.length > limit };
  }

  async listDevRuns(issueId: string, filter: DevRunListFilter = {}): Promise<DevRunListItem[]> {
    const page = await this.listDevRunsPage(issueId, filter, "", 10000);
    if (page.more) throw new DomainError("ARTIFACT_TOO_LARGE", "DevRun list exceeds 10,000 resources");
    return page.rows;
  }

  async listDevRunsPage(issueId: string, filter: DevRunListFilter, afterId: string, limit: number): Promise<{ rows: DevRunListItem[]; more: boolean }> {
    if (!Number.isInteger(limit) || limit < 1) throw validation("limit", "must be at least 1");
    const args: unknown[] = [];
    const conditions: string[] = [];
    if (issueId) { conditions.push("ir.issue_id = ?"); args.push(issueId); }
    if (filter.issue_version !== undefined) { conditions.push("ir.revision_number = ?"); args.push(filter.issue_version); }
    if (filter.repository_id) { conditions.push("i.repository_id = ?"); args.push(filter.repository_id); }
    if (filter.state) { conditions.push("d.state = ?"); args.push(filter.state); }
    if (afterId) { conditions.push("d.id > ?"); args.push(afterId); }
    const sql = `SELECT d.id, d.issue_revision_id, ir.issue_id, ${this.integerText("ir.revision_number")} AS issue_version, i.repository_id, ${this.integerText("d.version")} AS version, d.state, d.exploration_brief FROM dev_runs d JOIN issue_revisions ir ON ir.id = d.issue_revision_id JOIN issues i ON i.id = ir.issue_id${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY d.id LIMIT ?`;
    const rows = await this.client.all<Record<string, unknown>>(sql, [...args, limit + 1]);
    const result: DevRunListItem[] = [];
    const repositories = new Map<string, RepositoryRecord>();
    for (const row of rows.slice(0, limit)) {
      const devRunId = asText(row.id);
      try {
        const run = await this.getDevRun(devRunId);
        const revisionId = asText(row.issue_revision_id);
        const storedVersion = safeInteger(row.version, "version", 1);
        if (run.issue_revision_id !== revisionId || run.version !== storedVersion || run.state !== asText(row.state) || run.exploration_brief !== asOptionalText(row.exploration_brief)) throw new Error("DevRun list projection does not match its stored DevRun");
        const revision = await this.getIssueRevisionById(run.issue_revision_id);
        const issue = await this.getIssue(revision.issue_id);
        if (revision.issue_id !== asText(row.issue_id) || revision.revision_number !== safeInteger(row.issue_version, "issue_version", 1) || issue.repository_id !== asText(row.repository_id)) throw new Error("DevRun list ownership does not match its stored Issue");
        if (issueId && revision.issue_id !== issueId) throw new Error("DevRun does not belong to the requested Issue");
        let repository = repositories.get(issue.repository_id);
        if (!repository) { repository = await this.getRepository(issue.repository_id); repositories.set(repository.id, repository); }
        result.push({ id: run.id, issue_revision_id: run.issue_revision_id, issue_id: revision.issue_id, issue_version: revision.revision_number, repository_id: issue.repository_id, canonical_remote: repository.canonical_remote, version: run.version, state: run.state, ...(run.exploration_brief === undefined ? {} : { brief: run.exploration_brief }) });
      } catch (error) {
        return persistedRecordError("dev_run", devRunId, "stored DevRun list entry is invalid", error);
      }
    }
    return { rows: result, more: rows.length > limit };
  }

  async openDevRunCount(issueRevisionId: string): Promise<number> {
    const row = requireRow(await this.client.get<{ count: unknown }>("SELECT count(*) AS count FROM dev_runs WHERE issue_revision_id = ? AND state = 'open'", [issueRevisionId]), "issue_revision", issueRevisionId);
    return safeInteger(row.count, "open_dev_run_count");
  }

  async candidateCount(issueRevisionId: string): Promise<number> {
    const row = requireRow(await this.client.get<{ count: unknown }>("SELECT count(*) AS count FROM candidates WHERE issue_revision_id = ?", [issueRevisionId]), "issue_revision", issueRevisionId);
    return safeInteger(row.count, "candidate_count");
  }

  async readArtifact(patchDigest: string): Promise<Buffer> {
    throw new DomainError("UNSUPPORTED_CANDIDATE_ARTIFACT", "Historical SQL patch artifact reading is unsupported", false, { patch_digest: patchDigest });
  }

  async listDevRunRefinementVerifications(devRunId: string): Promise<string[]> {
    const rows = await this.client.all<{ ordinal: unknown; verification_id: unknown }>("SELECT ordinal, verification_id FROM dev_run_refinement_verifications WHERE dev_run_id = ? ORDER BY ordinal", [devRunId]);
    validateContiguousOrdinals(rows.map((row) => row.ordinal), "refinement_verification.ordinal", devRunId);
    return rows.map((row) => asText(row.verification_id));
  }

  /** Lineage is independent of verification reports and artifact availability. */
  async listCandidateLineage(issueRevisionId: string): Promise<Array<{ id: string; refines_candidate_id?: string }>> {
    const rows = await this.client.all<{ id: unknown }>("SELECT id FROM candidates WHERE issue_revision_id = ? AND artifact_format = ? ORDER BY id LIMIT 10001", [issueRevisionId, "grounds.git-commit-artifact/v1"]);
    if (rows.length > 10000) throw new DomainError("ARTIFACT_TOO_LARGE", "Candidate lineage exceeds 10,000 resources");
    const result: Array<{ id: string; refines_candidate_id?: string }> = [];
    for (const row of rows) {
      const record = await this.candidateMetadata(asText(row.id));
      if (record.candidate.issue_revision_id !== issueRevisionId) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate lineage ownership is invalid");
      result.push({ id: record.candidate.id, ...(record.refines_candidate_id ? { refines_candidate_id: record.refines_candidate_id } : {}) });
    }
    return result;
  }

  async listCandidates(issueRevisionId: string, filter: CandidateListFilter = {}): Promise<CandidateListItem[]> {
    const page = await this.listCandidatesPage(issueRevisionId, filter, undefined, 10000);
    if (page.more) throw new DomainError("ARTIFACT_TOO_LARGE", "Candidate list exceeds 10,000 resources");
    return page.rows;
  }

  async listCandidatesPage(issueRevisionId: string, filter: CandidateListFilter, after: ListPageKey | undefined, limit: number): Promise<{ rows: CandidateListItem[]; more: boolean }> {
    if (!Number.isInteger(limit) || limit < 1) throw validation("limit", "must be at least 1");
    const args: unknown[] = [];
    const conditions: string[] = [];
    if (issueRevisionId) { conditions.push("c.issue_revision_id = ?"); args.push(issueRevisionId); }
    if (filter.repository_id) { conditions.push("i.repository_id = ?"); args.push(filter.repository_id); }
    if (filter.selected !== undefined) conditions.push(`${filter.selected ? "" : "NOT "}EXISTS (SELECT 1 FROM selections s WHERE s.candidate_id = c.id)`);
    if (filter.standing) {
      const total = "(SELECT count(*) FROM verifications v WHERE v.candidate_id = c.id)";
      const qualified = "(SELECT count(*) FROM verifications v WHERE v.candidate_id = c.id AND v.overall_verdict = 'qualified')";
      const rejected = "(SELECT count(*) FROM verifications v WHERE v.candidate_id = c.id AND v.overall_verdict = 'rejected')";
      const expression = `CASE WHEN ${total} = 0 THEN 'unverified' WHEN ${qualified} > 0 AND ${rejected} > 0 THEN 'disputed' WHEN ${qualified} > 0 THEN 'qualified' WHEN ${rejected} > 0 THEN 'rejected' ELSE 'inconclusive' END`;
      conditions.push(`${expression} = ?`); args.push(filter.standing);
    }
    // Order is (created_at instant, id): compare through the fixed-width time key.
    const key = this.timeKey("c.created_at");
    if (after) { conditions.push(`(${key} > ? OR (${key} = ? AND c.id > ?))`); args.push(after.key, after.key, after.id); }
    const rows = await this.client.all<Record<string, unknown>>(`SELECT c.id, c.issue_revision_id, ir.issue_id, ${this.integerText("ir.revision_number")} AS issue_version, i.repository_id, c.created_at, ${key} AS order_key FROM candidates c JOIN issue_revisions ir ON ir.id = c.issue_revision_id JOIN issues i ON i.id = ir.issue_id${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY ${key}, c.id LIMIT ?`, [...args, limit + 1]);
    const result: CandidateListItem[] = [];
    const repositories = new Map<string, RepositoryRecord>();
    for (const row of rows.slice(0, limit)) {
      const candidateId = asText(row.id);
      try {
        const record = await this.candidateMetadata(candidateId);
        const createdAt = parseDate(row.created_at);
        if (record.candidate.id !== candidateId || record.candidate.issue_revision_id !== asText(row.issue_revision_id) || record.candidate.created_at !== createdAt) throw new Error("Candidate list projection does not match its stored Candidate");
        const revision = await this.getIssueRevisionById(record.candidate.issue_revision_id);
        const issue = await this.getIssue(revision.issue_id);
        if (revision.issue_id !== asText(row.issue_id) || revision.revision_number !== safeInteger(row.issue_version, "issue_version", 1) || issue.repository_id !== asText(row.repository_id)) throw new Error("Candidate list ownership does not match its stored Issue");
        let repository = repositories.get(issue.repository_id);
        if (!repository) { repository = await this.getRepository(issue.repository_id); repositories.set(repository.id, repository); }
        const counts = await this.verificationCounts(candidateId);
        if (filter.standing && standingFromCounts(counts.total, counts.qualified, counts.rejected) !== filter.standing) throw new Error("Candidate standing filter does not match its Verification records");
        result.push({ id: record.candidate.id, issue_revision_id: record.candidate.issue_revision_id, issue_id: revision.issue_id, issue_version: revision.revision_number, repository_id: issue.repository_id, canonical_remote: repository.canonical_remote, created_at: record.candidate.created_at, submission_explanation: record.candidate.submission.explanation, ...(record.refines_candidate_id ? { refines_candidate_id: record.refines_candidate_id } : {}), verification_total: counts.total, qualified_verifications: counts.qualified, rejected_verifications: counts.rejected , order_key: asText(row.order_key) });
      } catch (error) {
        return persistedRecordError("candidate", candidateId, "stored Candidate list entry is invalid", error);
      }
    }
    return { rows: result, more: rows.length > limit };
  }

  async verificationCount(candidateId: string): Promise<number> {
    const row = requireRow(await this.client.get<{ count: unknown }>("SELECT count(*) AS count FROM verifications WHERE candidate_id = ?", [candidateId]), "candidate", candidateId);
    return safeInteger(row.count, "verification_count");
  }

  async getVerificationSummary(verificationId: string): Promise<VerificationSummaryItem> {
    const row = requireRow(await this.client.get<Record<string, unknown>>("SELECT id, candidate_id, overall_verdict, created_at, attribution_json FROM verifications WHERE id = ?", [verificationId]), "verification", verificationId);
    return this.verificationSummaryFromRow(row);
  }

  async listVerificationSummaries(candidateId: string): Promise<VerificationSummaryItem[]> {
    // This method is the bounded summary projection used by refinement and
    // context callers: one page of at most 256 rows, with overflow rejected
    // instead of silently truncating.
    const page = await this.listVerificationSummariesPage(candidateId, "", 256);
    if (page.more) throw new DomainError("ARTIFACT_TOO_LARGE", "Verification summary list exceeds 256 resources");
    return page.rows;
  }

  async listVerifications(candidateId: string, filter: VerificationListFilter = {}): Promise<VerificationSummaryItem[]> {
    const page = await this.listVerificationsPage(candidateId, filter, undefined, 10000);
    if (page.more) throw new DomainError("ARTIFACT_TOO_LARGE", "Verification list exceeds 10,000 resources");
    return page.rows;
  }

  async listVerificationsPage(candidateId: string, filter: VerificationListFilter, after: ListPageKey | undefined, limit: number): Promise<{ rows: (VerificationSummaryItem & { order_key: string })[]; more: boolean }> {
    if (!Number.isInteger(limit) || limit < 1) throw validation("limit", "must be at least 1");
    const args: unknown[] = [];
    const conditions: string[] = [];
    if (candidateId) { conditions.push("v.candidate_id = ?"); args.push(candidateId); }
    if (filter.verdict) { conditions.push("v.overall_verdict = ?"); args.push(filter.verdict); }
    const vkey = this.timeKey("v.created_at");
    if (after) { conditions.push(`(${vkey} > ? OR (${vkey} = ? AND v.id > ?))`); args.push(after.key, after.key, after.id); }
    const rows = await this.client.all<Record<string, unknown>>(`SELECT v.id, v.candidate_id, v.overall_verdict, v.created_at, v.attribution_json, ${vkey} AS order_key, ir.issue_id, ${this.integerText("ir.revision_number")} AS issue_version FROM verifications v JOIN candidates c ON c.id = v.candidate_id JOIN issue_revisions ir ON ir.id = c.issue_revision_id${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY ${vkey}, v.id LIMIT ?`, [...args, limit + 1]);
    const result: (VerificationSummaryItem & { order_key: string })[] = [];
    for (const row of rows.slice(0, limit)) {
      const summary = await this.verificationSummaryFromRow(row, candidateId || undefined);
      const issueId = asText(row.issue_id);
      const issueVersion = safeInteger(row.issue_version, "issue_version", 1);
      try {
        const candidate = await this.candidateMetadata(summary.candidate_id);
        const revision = await this.getIssueRevisionById(candidate.candidate.issue_revision_id);
        if (revision.issue_id !== issueId || revision.revision_number !== issueVersion) throw new Error("Verification list ownership does not match its Candidate");
      } catch (error) {
        return persistedRecordError("verification", summary.id, "stored Verification list entry is invalid", error);
      }
      result.push({ ...summary, issue_id: issueId, issue_version: issueVersion, order_key: asText(row.order_key) });
    }
    return { rows: result, more: rows.length > limit };
  }

  async criterionStanding(candidateId: string, targetType: string, targetId: string, criterionId: string): Promise<string> {
    // The SQL aggregate is only a projection. Reconstruct every report for
    // this Candidate first so a direct database edit cannot influence
    // comparison standings without passing the same integrity checks as the
    // regular list/detail paths.
    await this.verificationCounts(candidateId);
    const row = await this.client.get<{ total: unknown; qualified: unknown; rejected: unknown }>("SELECT count(*) AS total, COALESCE(SUM(CASE WHEN final_verdict = 'qualified' THEN 1 ELSE 0 END), 0) AS qualified, COALESCE(SUM(CASE WHEN final_verdict = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected FROM verification_assessments va JOIN verifications v ON v.id = va.verification_id WHERE v.candidate_id = ? AND va.target_type = ? AND va.target_id = ? AND va.criterion_id = ?", [candidateId, targetType, targetId, criterionId]);
    const counts = row ?? { total: 0, qualified: 0, rejected: 0 };
    return standingFromCounts(safeInteger(counts.total, "verification_total"), safeInteger(counts.qualified, "qualified_verifications"), safeInteger(counts.rejected, "rejected_verifications"));
  }

  async requirementAggregateFacts(requirementId: string, selectedRevisionId: string): Promise<RequirementAggregateFacts> {
    const issueRows = await this.client.all<{ issue_count: unknown; repository_count: unknown; bound_count: unknown }>("SELECT count(*) AS issue_count, count(DISTINCT i.repository_id) AS repository_count, COALESCE(SUM(CASE WHEN ir.requirement_revision_id = ? THEN 1 ELSE 0 END),0) AS bound_count FROM issues i JOIN issue_revisions ir ON ir.issue_id = i.id WHERE i.requirement_id = ? AND NOT EXISTS (SELECT 1 FROM issue_revisions successor WHERE successor.predecessor_revision_id = ir.id)", [selectedRevisionId, requirementId]);
    const issue = issueRows[0] ?? { issue_count: 0, repository_count: 0, bound_count: 0 };
    const completed = await this.client.get<{ count: unknown }>(`SELECT count(*) AS count FROM issues i JOIN issue_revisions ir ON ir.issue_id = i.id WHERE i.requirement_id = ? AND ir.requirement_revision_id = ? AND NOT EXISTS (SELECT 1 FROM issue_revisions successor WHERE successor.predecessor_revision_id = ir.id) AND ${completedSQL('ir.id')}`, [requirementId, selectedRevisionId]);
    const open = await this.client.get<{ count: unknown }>("SELECT count(*) AS count FROM dev_runs d JOIN issue_revisions ir ON ir.id = d.issue_revision_id JOIN issues i ON i.id = ir.issue_id WHERE i.requirement_id = ? AND d.state = 'open'", [requirementId]);
    const candidates = await this.client.all<{ id: unknown }>("SELECT c.id FROM candidates c JOIN issue_revisions ir ON ir.id = c.issue_revision_id JOIN issues i ON i.id = ir.issue_id WHERE i.requirement_id = ? ORDER BY c.id", [requirementId]);
    const candidateStandings: CandidateVerificationCounts[] = [];
    for (const row of candidates) {
      const candidateId = asText(row.id);
      const candidate = await this.candidateMetadata(candidateId);
      const issueRevision = await this.getIssueRevisionById(candidate.candidate.issue_revision_id);
      const issueRecord = await this.getIssue(issueRevision.issue_id);
      if (issueRecord.requirement_id !== requirementId || issueRevision.requirement_id !== issueRecord.requirement_id) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate graph does not belong to the requested Requirement", false, { ...(validResourceId(candidateId) ? { resource_id: candidateId } : {}), reason: "Candidate, IssueRevision, Issue, and Requirement references do not agree" });
      const counts = await this.verificationCounts(candidateId);
      candidateStandings.push({ candidate_id: candidateId, total: counts.total, qualified: counts.qualified, rejected: counts.rejected });
    }
    return { completed_count: safeInteger(completed?.count ?? 0, "completed_count"), repository_count: safeInteger(issue.repository_count, "repository_count"), issue_count: safeInteger(issue.issue_count, "issue_count"), bound_count: safeInteger(issue.bound_count, "bound_count"), open_dev_run_count: safeInteger(open?.count ?? 0, "open_dev_run_count"), candidate_count: candidates.length, candidate_standings: candidateStandings };
  }

  async getLedgerEvent(eventId: string): Promise<LedgerEvent> {
    const row = requireRow(await this.client.get<Record<string, unknown>>(`SELECT ${this.integerText("event_seq")} AS event_seq, event_id, event_type, ${this.integerText("event_version")} AS event_version, operation_id, repository_id, subject_type, subject_id, ${this.integerText("subject_version")} AS subject_version, occurred_at, attribution_json, facts_json FROM ledger_events WHERE event_id = ?`, [eventId]), "database", eventId);
    return this.ledgerFromRow(row);
  }

  async listLedgerEventsPage(afterSeq: number, repositoryId: string, subjectType: string, subjectId: string, limit: number): Promise<{ rows: LedgerEvent[]; more: boolean }> {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw validation("after_seq", "must be a non-negative safe integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw validation("limit", "must be between 1 and 1000");
    const args: unknown[] = [afterSeq];
    let where = "WHERE event_seq > ?";
    if (repositoryId) { where += " AND repository_id = ?"; args.push(repositoryId); }
    if (subjectType) { where += " AND subject_type = ?"; args.push(subjectType); }
    if (subjectId) { where += " AND subject_id = ?"; args.push(subjectId); }
    args.push(limit + 1);
    const rows = await this.client.all<Record<string, unknown>>(`SELECT ${this.integerText("event_seq")} AS event_seq, event_id, event_type, ${this.integerText("event_version")} AS event_version, operation_id, repository_id, subject_type, subject_id, ${this.integerText("subject_version")} AS subject_version, occurred_at, attribution_json, facts_json FROM ledger_events ${where} ORDER BY ledger_events.event_seq LIMIT ?`, args);
    return { rows: rows.slice(0, limit).map((row) => this.ledgerFromRow(row)), more: rows.length > limit };
  }

  protected ledgerFromRow(row: Record<string, unknown>): LedgerEvent {
    const eventId = asText(row.event_id);
    try {
      const eventType = asText(row.event_type);
      const operationId = asText(row.operation_id);
      const subjectType = asText(row.subject_type);
      const subjectId = asText(row.subject_id);
      const repositoryId = asOptionalText(row.repository_id);
      const hasSubjectVersion = row.subject_version !== null && row.subject_version !== undefined;
      const versionedSubjects = new Set(["delivery_link", "requirement_revision", "issue_revision", "repository", "dev_run", "selection", "issue_completion", "eval_qa", "eval_artifact", "eval_grader", "eval_suite", "eval_snapshot", "eval_experiment", "eval_run", "eval_execution", "eval_result", "eval_notice", "eval_environment", "eval_envcheck", "eval_preparation", "eval_instance"]);
      const repositorylessSubjects = new Set(["requirement", "requirement_revision", "eval_qa", "eval_artifact", "eval_grader", "eval_suite", "eval_snapshot", "eval_experiment", "eval_run", "eval_execution", "eval_result", "eval_notice", "eval_environment", "eval_envcheck", "eval_preparation", "eval_instance"]);
      if (!isUUIDv7(eventId) || !eventType || [...eventType].length > 256 || !isUUIDv7(operationId) || !["delivery_link", "requirement", "requirement_revision", "repository", "issue", "issue_revision", "dev_run", "candidate", "verification", "selection", "issue_completion", "eval_qa", "eval_artifact", "eval_grader", "eval_suite", "eval_snapshot", "eval_experiment", "eval_run", "eval_execution", "eval_result", "eval_notice", "eval_environment", "eval_envcheck", "eval_preparation", "eval_instance"].includes(subjectType) || !isUUIDv7(subjectId)) throw new Error("LedgerEvent identifiers or type are invalid");
      if (repositorylessSubjects.has(subjectType)) {
        if (repositoryId !== undefined) throw new Error("LedgerEvent repository binding is invalid");
      } else if (repositoryId === undefined || !isUUIDv7(repositoryId)) {
        throw new Error("LedgerEvent repository binding is invalid");
      }
      if (versionedSubjects.has(subjectType)) {
        if (!hasSubjectVersion) throw new Error("LedgerEvent subject version is missing");
      } else if (hasSubjectVersion) {
        throw new Error("LedgerEvent subject version is not allowed");
      }
      const event: LedgerEvent = { event_seq: safeInteger(row.event_seq, "event_seq", 1), event_id: eventId, event_type: eventType, event_version: safeInteger(row.event_version, "event_version", 1), operation_id: operationId, subject_type: subjectType, subject_id: subjectId, occurred_at: parseDate(row.occurred_at), attribution: parseAttribution(row.attribution_json), facts: storedLedgerFacts(row.facts_json, eventId) };
      if (repositoryId !== undefined) event.repository_id = repositoryId;
      if (hasSubjectVersion) event.subject_version = safeInteger(row.subject_version, "subject_version", 1);
      return event;
    } catch (error) {
      return persistedRecordError("database", eventId, "stored LedgerEvent is invalid", error);
    }
  }

  async getLedgerEventForIntegrity(eventId: string): Promise<LedgerEvent> { return this.getLedgerEvent(eventId); }
}
