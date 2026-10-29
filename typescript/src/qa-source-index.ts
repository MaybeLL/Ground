import { validation } from './errors.js';

type Rule = 'id' | 'locator' | 'hash' | 'count' | 'boolean' | readonly string[] | { items: Rule; max: number } | { properties: Record<string, Rule>; required?: string[] };
const ids: Rule = { items: 'id', max: 1000 };
const versionRef: Rule = { properties: { id: 'id', version: 'count' }, required: ['id', 'version'] };
const coverage = ['complete', 'partial', 'missing', 'unknown', 'not_applicable'] as const;
const completeness: Rule = { properties: Object.fromEntries(['question', 'query', 'answer', 'feedback', 'attachments', 'subtasks'].map(k => [k, coverage])) };
const material: Rule = { properties: { id: 'id', scope: 'id', kind: ['host_event', 'persisted_message', 'cli_start', 'cli_result', 'clue', 'question', 'query', 'answer', 'feedback', 'model_proposal', 'missing_record'], sha256: 'hash', bytes: 'count',
  first_captured_at: 'count', expires_at: 'count' }, required: ['id', 'kind', 'sha256', 'bytes', 'first_captured_at', 'expires_at'] };
const contextRead: Rule = { properties: { state: ['completed', 'rejected'], request_digest: 'hash', requested_count: 'count',
  material_ids: ids, scopes: ids, authorization_digest: 'hash', input_digest: 'hash', added_bytes: 'count', missing_count: 'count',
  reason: 'id', records: { items: material, max: 64 } },
  required: ['state', 'request_digest', 'requested_count', 'material_ids', 'scopes', 'authorization_digest', 'input_digest', 'added_bytes', 'missing_count'] };

/** A closed provenance index. Body belongs in digest-checked, expiring evidence,
 * including model proposals. Unknown keys are rejected rather than renamed or
 * silently stripped; this does not claim to detect arbitrary encoded secrets. */
const index: Rule = { properties: {
  format: ['graphkb.qa-source/v1', 'graphkb.qa-source/v2', 'grounds.tui-qa-source/v1'], kind: ['captured_review', 'manual', 'manual_revision'], scope: 'id', original_question: 'id', question_index: 'count',
  origin_key: 'hash', question_span_digest: 'hash', model_question_proposal_digest: 'hash', model_proposal_id: 'id',
  question_policy: ['original_span_until_review', 'normalized_unverified'],
  observation: ['model_extraction_unverified'], condition_type: ['stable', 'current_state', 'historical_state', 'unknown'],
  call_ids: ids, message_ids: ids, material_ids: ids, clue_ids: ids,
  authorization_digest: 'hash', input_digest: 'hash', context_reads: { items: contextRead, max: 8 },
  source_package: 'hash', lineage_digest: 'hash', digest_algorithm: ['JCS-SHA256'], based_on: versionRef,
  captured_sources: { items: { properties: { identity: 'id', revision: 'id',
    provenance: { properties: { repository: 'locator', revision: 'id', path: 'locator', digest: 'hash', record_digest: 'hash' } },
    relations_digest: 'hash', completeness, limitations_digest: 'hash' } }, max: 100 },
  manual_revision: { properties: { kind: ['human'], draft: 'id', draft_id: 'id', version: 'count', editing_version: 'count',
    digest: 'hash', based_on: versionRef, fields: { items: ['name', 'question', 'instructions', 'rubric', 'reference_answer', 'required_points', 'forbidden_claims', 'references'], max: 8 } } },
  review: { properties: { status: ['pending', 'reviewed', 'ignored', 'not_applicable'], knowledge: ['unknown', 'stable', 'historical'],
    authority_digest: 'hash', conditions_digest: 'hash', independent_text: 'boolean', attachments_resolved: 'boolean' } },
} };

function check(value: unknown, rule: Rule, field: string): void {
  const fail = () => { throw validation(field, 'expected bounded provenance index; body or unknown fields belong in evidence'); };
  if (typeof rule === 'string') {
    if (rule === 'id') { if (typeof value !== 'string' || !/^[A-Za-z0-9_.:@/#=+~-]{1,512}$/.test(value)) fail(); }
    else if (rule === 'locator') { if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096 || /[\x00-\x1f\x7f]/u.test(value)) fail(); }
    else if (rule === 'hash') { if (typeof value !== 'string' || !/^(?:sha256:)?[0-9a-f]{64}$/.test(value)) fail(); }
    else if (rule === 'count') { if (!Number.isSafeInteger(value) || Number(value) < 0) fail(); }
    else if (typeof value !== 'boolean') fail();
  } else if (Array.isArray(rule)) {
    if (!rule.includes(value as string)) fail();
  } else if ('items' in rule) {
    if (!Array.isArray(value) || value.length > rule.max) return fail();
    value.forEach((item, at) => check(item, rule.items, `${field}[${at}]`));
  } else {
    const shape = rule as Extract<Rule, { properties: unknown }>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const object = value as Record<string, unknown>;
    if (Object.keys(object).some(key => !Object.hasOwn(shape.properties, key)) || shape.required?.some(key => !Object.hasOwn(object, key))) fail();
    for (const [key, item] of Object.entries(object)) check(item, shape.properties[key]!, `${field}.${key}`);
  }
}
export function validateSourceIndex(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 65536) throw validation('source.record', 'provenance index exceeds 64 KiB');
  check(value, index, 'source.record');
}

// The published schema and the runtime share the same closed structure. Tests
// compare its generated representation with the canonical contract file.
export function sourceIndexSchema(): Record<string, unknown> {
  const schema = (rule: Rule): Record<string, unknown> => {
    if (rule === 'id') return { type: 'string', minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9_.:@/#=+~-]+$' };
    if (rule === 'locator') return { type: 'string', minLength: 1, maxLength: 4096, pattern: '^[^\\u0000-\\u001f\\u007f]+$' };
    if (rule === 'hash') return { type: 'string', pattern: '^(?:sha256:)?[0-9a-f]{64}$' };
    if (rule === 'count') return { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
    if (rule === 'boolean') return { type: 'boolean' };
    if (Array.isArray(rule)) return { type: 'string', enum: rule };
    if ('items' in rule) return { type: 'array', items: schema(rule.items), maxItems: rule.max };
    const shape = rule as Extract<Rule, { properties: unknown }>;
    return { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.entries(shape.properties).map(([key, value]) => [key, schema(value)])), ...(shape.required ? { required: shape.required } : {}) };
  };
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://grounds.dev/contracts/v1/qa-source-index.schema.json', ...schema(index) };
}
