import type { Attribution } from './domain.js';
import { validateAttribution, validateTargetBranchSpec } from './domain.js';
import { isUUIDv7, isGitOID } from './identity.js';
import { validation } from './errors.js';

/** External facts asserted by the recorder; recording never verifies a URL or releases software. */
export interface CompletionEvidence { reference: string; description: string }
export interface CompletionInput {
  format: 'grounds.issue-completion-input/v1';
  origin: 'workflow' | 'historical';
  repository_id: string;
  target_branch: string;
  landed_commit: string;
  adoption_evidence: CompletionEvidence;
  release: { status: 'released'; version: string; channel: string; evidence: CompletionEvidence }
    | { status: 'not_applicable'; reason: string };
  completed_at: string;
  candidate_id?: string;
}
export interface CompletionRecord {
  version: number;
  state: 'completed' | 'reopened';
  recorded_at: string;
  attribution: Attribution;
  evidence_status: 'asserted_not_checked';
  completion: CompletionInput;
  reason?: string;
}
export interface CompletionView {
  version: number;
  state: 'unrecorded' | 'completed' | 'reopened';
  record?: CompletionRecord;
}
export interface CompletionResult {
  result_type: 'grounds.result.issue-completion/v1';
  command: 'completion.record' | 'completion.reopen' | 'completion.show';
  issue: { id: string; version: number };
  completion: CompletionView;
  history?: CompletionRecord[];
  current_verification?: import('./review.js').VerificationSetSummary;
  warnings: { code: string; message: string }[];
}
export interface CompletionWriteCommand {
  operation_id: string;
  issue_id: string;
  issue_version: number;
  expected_version: number;
  attribution: Attribution;
}
export function completionText(value: unknown, field: string, limit = 4096): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /\u0000/.test(value)) throw validation(field, `requires nonempty text of at most ${limit} characters`);
}
function object(value: unknown, field: string, keys: string[], required = keys): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(value, k))) throw validation(field, 'invalid fields');
}
function evidence(value: unknown, field: string): void {
  object(value, field, ['reference', 'description']);
  completionText(value.reference, `${field}.reference`); completionText(value.description, `${field}.description`);
}
function date(value: unknown, field: string): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw validation(field, 'requires a real UTC timestamp with milliseconds');
}
export function validateCompletionInput(value: unknown): asserts value is CompletionInput {
  const fields = ['format', 'origin', 'repository_id', 'target_branch', 'landed_commit', 'adoption_evidence', 'release', 'completed_at'];
  object(value, 'completion', [...fields, 'candidate_id'], fields);
  if (value.format !== 'grounds.issue-completion-input/v1') throw validation('format', 'unsupported completion input format');
  if (!['workflow', 'historical'].includes(String(value.origin))) throw validation('origin', 'must be workflow or historical');
  if (!isUUIDv7(value.repository_id as string)) throw validation('repository_id', 'UUIDv7 required');
  if (value.candidate_id !== undefined && !isUUIDv7(value.candidate_id as string)) throw validation('candidate_id', 'UUIDv7 required');
  completionText(value.target_branch, 'target_branch', 1024);
  validateTargetBranchSpec({ remote: 'origin', ref: value.target_branch });
  if (!isGitOID(value.landed_commit as string)) throw validation('landed_commit', 'requires a full algorithm-qualified Git OID');
  date(value.completed_at, 'completed_at'); evidence(value.adoption_evidence, 'adoption_evidence');
  const release = value.release;
  if (!release || typeof release !== 'object') throw validation('release', 'release facts or explicit not_applicable reason required');
  if ((release as Record<string, unknown>).status === 'released') {
    object(release, 'release', ['status', 'version', 'channel', 'evidence']);
    completionText(release.version, 'release.version', 256); completionText(release.channel, 'release.channel', 256); evidence(release.evidence, 'release.evidence');
  } else {
    object(release, 'release', ['status', 'reason']);
    if (release.status !== 'not_applicable') throw validation('release.status', 'must be released or not_applicable; pending release is not completed');
    completionText(release.reason, 'release.reason');
  }
}
export function validateCompletionRecord(record: CompletionRecord): void {
  object(record, 'completion_record', ['version', 'state', 'recorded_at', 'attribution', 'evidence_status', 'completion', 'reason'], ['version', 'state', 'recorded_at', 'attribution', 'evidence_status', 'completion']);
  if (!Number.isSafeInteger(record.version) || record.version < 1 || record.version > 2147483647) throw validation('version', 'invalid completion version');
  if (!['completed', 'reopened'].includes(record.state) || record.evidence_status !== 'asserted_not_checked') throw validation('completion_record', 'invalid state or evidence status');
  if (record.state === 'reopened') completionText(record.reason, 'reason');
  else if (record.reason !== undefined) throw validation('reason', 'only accepted when reopening');
  date(record.recorded_at, 'recorded_at'); validateAttribution(record.attribution); validateCompletionInput(record.completion);
}
export const completionView = (record?: CompletionRecord): CompletionView => record ? { version: record.version, state: record.state, record } : { version: 0, state: 'unrecorded' };
export const completionProgress = (bound: number, completed: number): 'completed' | 'incomplete' | 'no_issues' => bound === 0 ? 'no_issues' : bound === completed ? 'completed' : 'incomplete';
