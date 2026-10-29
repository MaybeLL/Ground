import type { ReadTx, CandidateRecord } from "./store-types.js";
import type { ArchiveOperation } from "./candidate-archive-service.js";
import { archiveOperation } from "./candidate-archive-service.js";
import type { IntegrationRecord } from "./integration-service.js";
import { DomainError } from "./errors.js";
import { sha256 } from "./canonical-json.js";

export interface CandidateLineage {
  candidate_id: string;
  refines_candidate_id?: string;
  successor_candidate_ids: string[];
  successors_omitted: boolean;
  initial_base_commit?: string;
}
export interface CandidateHistoryProjection {
  lineage: CandidateLineage;
  archive_history: ArchiveOperation[];
  adoption: IntegrationRecord[];
}

/** Fixed ledger facts only; no implicit fetch, branch-name inference or wall-clock selection. */
export async function candidateHistoryProjection(tx: ReadTx, record: {candidate: Pick<CandidateRecord["candidate"], "id" | "issue_revision_id" | "dev_run_id">; refines_candidate_id?: string}): Promise<CandidateHistoryProjection> {
  const candidate = record.candidate;
  const candidates = await tx.listCandidateLineage(candidate.issue_revision_id);
  const children = candidates.filter(item => item.refines_candidate_id === candidate.id);
  const seen = new Set<string>();
  let root = record;
  while (root.refines_candidate_id) {
    if (seen.has(root.candidate.id)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate refinement cycle is invalid");
    seen.add(root.candidate.id);
    const parent = candidates.find(item => item.id === root.refines_candidate_id);
    const ref = parent && await tx.findCandidateArtifactRef({candidate_id: parent.id});
    if (!parent || !ref || ref.issue_revision_id !== candidate.issue_revision_id) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate lineage crosses Issue Versions or lacks its fixed predecessor");
    root = {candidate: {id: ref.candidate_id, issue_revision_id: ref.issue_revision_id, dev_run_id: ref.dev_run_id}, refines_candidate_id: parent.refines_candidate_id};
  }
  const run = await tx.getDevRun(root.candidate.dev_run_id);
  const operations = [...await tx.listRuntimeRecords("runtime_operation", candidate.dev_run_id), ...await tx.listRuntimeRecords("runtime_operation", candidate.id)];
  const archive_history = operations.filter(row => row.data.format === "grounds.candidate-archive-operation/v1").map(archiveOperation).filter(data => data.candidate_id === candidate.id);
  const adoption: IntegrationRecord[] = [];
  let after = 0;
  while (true) {
    const page = await tx.listLedgerEventsPage(after, "", "candidate", candidate.id, 256);
    for (const event of page.rows) {
      if (event.event_type !== "integration.landing") continue;
      try {
        const fact = event.facts.find(item => item.name === "record");
        const value = fact && JSON.parse(fact.value) as IntegrationRecord;
        if (value?.kind === "landing" && value.candidate_id === candidate.id && value.id === event.event_id
          && value.created_at === event.occurred_at && sha256(value.attribution) === sha256(event.attribution)
          && sha256(value) === event.facts.find(item => item.name === "record_digest")?.value) adoption.push(value);
        else throw new Error();
      } catch { throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate adoption history has invalid fixed bindings"); }
    }
    if (!page.more) break;
    if (!page.rows.length) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate history page is incomplete");
    after = page.rows[page.rows.length - 1]!.event_seq!;
  }
  return {
    lineage: { candidate_id: candidate.id, ...(record.refines_candidate_id ? { refines_candidate_id: record.refines_candidate_id } : {}), successor_candidate_ids: children.map(item => item.id), successors_omitted: false, ...(run.initial_base_commit ? { initial_base_commit: run.initial_base_commit } : {}) },
    archive_history, adoption,
  };
}
