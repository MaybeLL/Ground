import { readdirSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256, sha256Bytes } from './canonical-json.js';
import { parseDocument } from 'yaml';
import { newUUIDv7, isSha256, isUUIDv7 } from './identity.js';
import { validation, versionConflict } from './errors.js';
import { atomicPrivateWrite, privateDirectory, safeRead, withRuntimeLock } from './runtime-files.js';
import type { QADraft } from './eval-qa.js';
import { validateSourceIndex } from './qa-source-index.js';

/** Strict UTF-8 JSON with duplicate-key rejection, bounded separately from small eval inputs. */
export function decodeMaterialJSON(bytes: Buffer): unknown {
  if (bytes.length > 32 * 1024 * 1024) throw validation('file', 'maximum is 32 MiB');
  let text: string, value: unknown;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); value = JSON.parse(text); } catch { throw validation('file', 'invalid UTF-8 JSON'); }
  const doc = parseDocument(text, { uniqueKeys: true }); if (doc.errors.length) throw validation('file', doc.errors[0].message);
  const visit = (v: unknown, depth: number) => { if (depth > 64) throw validation('file', 'nested input exceeds 64 levels');if(typeof v==='number'&&!Number.isFinite(v))throw validation('file','non-finite number');if(typeof v==='string'&&Buffer.from(v).toString('utf8')!==v)throw validation('file','invalid Unicode string'); if (v && typeof v === 'object') { if (!Array.isArray(v) && Object.keys(v).some(k => ['__proto__', 'constructor', 'prototype'].includes(k)||Buffer.from(k).toString('utf8')!==k)) throw validation('file', 'reserved object key'); Object.values(v).forEach(x => visit(x, depth + 1)); } }; visit(value, 0); return value;
}
export type QAContent = Partial<Omit<QADraft, 'source'>> & { source?: QADraft['source']; };
export interface CandidateEvidence { id: string; kind: string; locator: string; content: string; digest: string; first_captured_at: string; expires_at: string; }
export interface CandidateHandoff {
  format: 'grounds.qa-candidate/v1'; identity: string; revision: string;
  project: { id: string; first_captured_at: string; expires_at: string; };
  qa: QAContent; evidence: CandidateEvidence[]; relations: Record<string, unknown>;
  limitations: string[]; completeness: Record<string, string>;
  extraction: Record<string, unknown>;
}
export interface QuestionOrigin { key: string; batch: string; span_digest?: string; }
export interface MaterialReference { file: string; digest: string; identity: string; revision: string; project: CandidateHandoff['project']; origin?: QuestionOrigin; }
export interface DraftReview {
  status: 'pending' | 'reviewed' | 'ignored' | 'not_applicable';
  independent_text: boolean; authority: string; attachments_resolved: boolean;
  knowledge: 'unknown' | 'stable' | 'historical';
  answer_conditions?: { accessible: boolean; locator: string; instructions: string; preserves_question: boolean; };
}
export interface DraftTarget { suite: { id: string; version: number; }; member: { mode: 'add' | 'update'; id?: string; }; template: { id: string; version: number; }; qa?: { id: string; version: number; }; }
export interface PublicationStep { name: 'source' | 'qa' | 'grader' | 'suite'; operation_id: string; input_digest: string; input: unknown; status: 'pending' | 'completed' | 'rejected'; result?: unknown; error?: unknown; replaces?: string; }
export interface CandidateJournal { id: string; database_id: string; attribution: import('./domain.js').Attribution; preview_digest: string; target: DraftTarget; steps: PublicationStep[]; qa?: QADraft; template?: Record<string, unknown>; state: 'pending' | 'partial' | 'conflict' | 'published' | 'cancelled'; }
export interface LocalQADraft {
  format: 'grounds.qa-draft/v1'; id: string; version: number; identity: string;
  state: 'active' | 'replaced' | 'boundary_pending'; automatic: MaterialReference[]; suggestions: MaterialReference[];
  boundary?: { related_drafts: string[]; reason: 'origin_repartitioned' | 'legacy_origin_unavailable'; decision?: 'new' | 'existing'; };
  bootstrap_origins?: QuestionOrigin[]; origin_closed?: boolean;
  manual: QAContent; review: DraftReview; predecessors: string[]; successors: string[];
  lineage: { action: string; sources: string[]; at: string; }[];
  saved?: { digest: string; database_id: string; operation_id?: string; }; retained?: QAContent; retained_packages?: {digest:string;database_id:string;operation_id?:string}[]; journal?: CandidateJournal; publication_history?: CandidateJournal[]; source_saves?: { operation_id: string; database_id: string; expected_version: number; input: { digest: string ;}; attribution: import('./domain.js').Attribution; result?: unknown; }[];
}
export const QA_FIELDS = ['name', 'question', 'instructions', 'rubric', 'reference_answer', 'required_points', 'forbidden_claims', 'references'] as const;
const boundedText = (x: unknown, field: string, max = 65536, allowEmpty = false): string => {
  if (typeof x !== 'string' || (!allowEmpty && !x.trim()) || Buffer.byteLength(x) > max || Buffer.from(x).toString('utf8')!==x) throw validation(field, 'expected bounded text');
  return x;
};
const record = (x: unknown, field: string, max = 65536): Record<string, unknown> => {
  if (!x || typeof x !== 'object' || Array.isArray(x) || Buffer.byteLength(JSON.stringify(x)) > max) throw validation(field, 'expected bounded object');
  return x as Record<string, unknown>;
};
const timestamp = (x: unknown, field: string): string => { const s = boundedText(x, field, 128); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 19) !== s.slice(0, 19)) throw validation(field, 'expected RFC3339 UTC timestamp'); return s; };
export function content(value: unknown): QAContent {
  const o = record(value, 'qa', 2 * 1024 * 1024);
  if (Object.keys(o).some(k => ![...QA_FIELDS, 'format', 'source'].includes(k as any))) throw validation('qa', 'unknown content field');
  if (o.format !== undefined && o.format !== 'grounds.eval-qa/v1') throw validation('qa.format', 'expected grounds.eval-qa/v1');
  for (const k of QA_FIELDS) if (o[k] !== undefined) {
    if (['required_points', 'forbidden_claims', 'references'].includes(k)) {
      if (!Array.isArray(o[k]) || (o[k] as unknown[]).length > 1000) throw validation(k, 'expected bounded strings');
      (o[k] as unknown[]).forEach(v => boundedText(v, k));
    } else boundedText(o[k], k, k === 'name' ? 1024 : 65536, true);
  }
  if (o.source !== undefined) {
    const s = record(o.source, 'source');
    for (const k of ['identity', 'repository', 'revision', 'path']) boundedText(s[k], `source.${k}`);
    if (!isSha256(s.digest)) throw validation('source.digest', 'expected sha256');
    record(s.record, 'source.record');
    validateSourceIndex(s.record);
  }
  return structuredClone(o) as QAContent;
}
function lifespan(first: string, expires: string, field: string) {
  if (Date.parse(expires) <= Date.parse(first) || Date.parse(expires) - Date.parse(first) > 7 * 86400000) throw validation(field, 'expiry must inherit at most seven days from first capture');
}
export function decodeCandidate(value: unknown, now = Date.now()): CandidateHandoff {
  const o = record(value, 'candidate', 32 * 1024 * 1024);
  const allowed = ['format', 'identity', 'revision', 'project', 'qa', 'evidence', 'relations', 'limitations', 'completeness', 'extraction'];
  if (o.format !== 'grounds.qa-candidate/v1' || Object.keys(o).some(k => !allowed.includes(k))) throw validation('candidate', 'incompatible candidate format');
  const project = record(o.project, 'project');
  const p = { id: boundedText(project.id, 'project.id'), first_captured_at: timestamp(project.first_captured_at, 'first_captured_at'), expires_at: timestamp(project.expires_at, 'expires_at') };
  lifespan(p.first_captured_at, p.expires_at, 'project');
  if (now > 0 && Date.parse(p.first_captured_at) > now) throw validation('project', 'first capture cannot be in the future');
  if (Date.parse(p.expires_at) <= now) throw validation('materials', 'automatic materials expired');
  if (!Array.isArray(o.evidence) || o.evidence.length < 1 || o.evidence.length > 1000) throw validation('evidence', 'expected 1–1000 bounded records');
  const ids = new Set<string>();
  const evidence = o.evidence.map(v => {
    const e = record(v, 'evidence', 2 * 1024 * 1024);
    const result = { id: boundedText(e.id, 'evidence.id'), kind: boundedText(e.kind, 'evidence.kind', 128), locator: boundedText(e.locator, 'evidence.locator'), content: boundedText(e.content, 'evidence.content', 1024 * 1024, true), digest: String(e.digest), first_captured_at: timestamp(e.first_captured_at, 'evidence.first_captured_at'), expires_at: timestamp(e.expires_at, 'evidence.expires_at') };
    lifespan(result.first_captured_at, result.expires_at, 'evidence');
    if (['hidden_reasoning', 'credentials', 'secret'].includes(result.kind)) throw validation('evidence', 'hidden reasoning or credentials are not supported');
    if (!isSha256(result.digest) || sha256Bytes(Buffer.from(result.content)) !== result.digest || ids.has(result.id)) throw validation('evidence', 'duplicate identity or content digest mismatch');
    ids.add(result.id);
    if (Date.parse(p.first_captured_at) > Date.parse(result.first_captured_at) || Date.parse(p.expires_at) > Date.parse(result.expires_at)) throw validation('project', 'project must inherit oldest first capture and earliest expiry');
    return result;
  });
  if (!Array.isArray(o.limitations) || o.limitations.length > 1000) throw validation('limitations', 'expected bounded strings');
  const completeness = record(o.completeness, 'completeness');
  for (const [k, v] of Object.entries(completeness)) if (!['question', 'query', 'answer', 'feedback', 'attachments', 'subtasks'].includes(k) || !['complete', 'partial', 'missing', 'unknown', 'not_applicable'].includes(String(v))) throw validation('completeness', 'invalid coverage');
  for (const k of ['question', 'query', 'answer', 'feedback', 'attachments', 'subtasks']) if (!completeness[k]) throw validation('completeness', `missing ${k}`);
  const qa = content(o.qa), identity = boundedText(o.identity, 'identity');
  if (qa.source && qa.source.identity !== identity) throw validation('identity', 'candidate and QA source identity differ');
  return { format: o.format, identity, revision: boundedText(o.revision, 'revision'), project: p, qa, evidence, relations: record(o.relations, 'relations'), limitations: o.limitations.map(v => boundedText(v, 'limitations')), completeness: completeness as Record<string, string>, extraction: record(o.extraction, 'extraction') };
}
export function readCandidate(file: string, expected?: string, now = Date.now()): { handoff: CandidateHandoff; reference: MaterialReference; } {
  const bytes = safeRead(resolve(file), 32 * 1024 * 1024), digest = sha256Bytes(bytes);
  if (expected && digest !== expected) throw validation('materials', 'handoff content changed');
  const handoff = decodeCandidate(decodeMaterialJSON(bytes), now);
  const source = handoff.qa.source, index = source?.record;
  const origin = index && ['graphkb.qa-source/v1', 'graphkb.qa-source/v2'].includes(String(index.format))
    && typeof index.origin_key === 'string' ? { key: sha256({project: handoff.project.id, origin: index.origin_key}),
      batch: typeof handoff.extraction.run_id === 'string' && handoff.extraction.run_id.length > 0 && typeof handoff.extraction.input_digest === 'string' && /^(?:sha256:)?[0-9a-f]{64}$/.test(handoff.extraction.input_digest)
        ? sha256({run: handoff.extraction.run_id, input: handoff.extraction.input_digest}) : sha256({unverified_packet: digest}),
      ...(typeof index.question_span_digest === 'string' ? {span_digest: index.question_span_digest} : {}) } : undefined;
  return { handoff, reference: { file: resolve(file), digest, identity: handoff.identity, revision: handoff.revision, project: handoff.project, ...(origin ? {origin} : {}) } };
}
export function validateReview(raw: unknown): DraftReview {
  const o = record(raw, 'review');
  if(Object.keys(o).some(k=>!['status','independent_text','authority','attachments_resolved','knowledge','answer_conditions'].includes(k)))throw validation('review','unknown review field');
  if (!['pending', 'reviewed', 'ignored', 'not_applicable'].includes(String(o.status)) || !['unknown', 'stable', 'historical'].includes(String(o.knowledge))) throw validation('review', 'invalid review state');
  for (const k of ['independent_text', 'attachments_resolved']) if (typeof o[k] !== 'boolean') throw validation('review', `missing ${k}`);
  boundedText(o.authority, 'review.authority', 65536, true);
  if (o.answer_conditions !== undefined) {
    const c = record(o.answer_conditions, 'answer_conditions');
    if(Object.keys(c).some(k=>!['accessible','locator','instructions','preserves_question'].includes(k)))throw validation('answer_conditions','unknown condition field');
    if (typeof c.accessible !== 'boolean' || typeof c.preserves_question !== 'boolean') throw validation('answer_conditions', 'requires accessible and preserves_question');
    boundedText(c.locator, 'answer_conditions.locator', 65536, true); boundedText(c.instructions, 'answer_conditions.instructions', 65536, true);
  }
  return structuredClone(o) as unknown as DraftReview;
}

/** Authoritative local drafts contain pointers to expiring KB materials, never automatic text copies. */
export class QADraftStore {
  readonly root: string;
  constructor(root = process.env.GROUNDS_QA_DRAFT_HOME ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'grounds', 'qa-drafts')) { this.root = resolve(root); }
  async locked<T>(fn: () => Promise<T>): Promise<T> { privateDirectory(this.root); return withRuntimeLock(this.root, 'qa-drafts', async () => { this.recover(); return fn(); }, 10000); }
  private recover() {
    const path = join(this.root, 'transaction.json'); if (!existsSync(path)) return;
    const pending = decodeMaterialJSON(safeRead(path, 32 * 1024 * 1024)) as { format: string; drafts: LocalQADraft[] ;};
    if (pending.format !== 'grounds.qa-draft-transaction/v1' || !Array.isArray(pending.drafts)) throw validation('draft', 'invalid recovery transaction');
    pending.drafts.forEach(d => this.save(d)); unlinkSync(path);
  }
  private saveMany(drafts: LocalQADraft[]) {
    atomicPrivateWrite(join(this.root, 'transaction.json'), JSON.stringify({ format: 'grounds.qa-draft-transaction/v1', drafts }));
    this.recover();
  }
  path(id: string) { if (!isUUIDv7(id)) throw validation('draft', 'expected UUIDv7'); return join(this.root, id + '.json'); }
  load(id: string): LocalQADraft {
    if (existsSync(join(this.root, 'transaction.json'))) throw validation('draft', 'interrupted multi-draft change; retry through CLI to recover');
    const d = decodeMaterialJSON(safeRead(this.path(id), 4 * 1024 * 1024)) as LocalQADraft;
    if (d.format !== 'grounds.qa-draft/v1' || d.id !== id || !Number.isSafeInteger(d.version)) throw validation('draft', 'invalid local draft');
    return d;
  }
  list(): LocalQADraft[] { privateDirectory(this.root); return readdirSync(this.root).filter(n => /^[0-9a-f-]{36}\.json$/.test(n)).sort().map(n => this.load(n.slice(0, -5))); }
  save(d: LocalQADraft) { privateDirectory(this.root); const bytes = JSON.stringify(d); if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) throw validation('draft', 'local metadata exceeds 4 MiB'); atomicPrivateWrite(this.path(d.id), bytes); }
  check(d: LocalQADraft, version: number) { if (d.version !== version) throw versionConflict('eval_qa', d.id, version, d.version); }
  mutable(d: LocalQADraft) { if (d.state !== 'active' || d.source_saves?.some(s => !s.result) || d.journal && !['published', 'cancelled'].includes(d.journal.state)) throw validation('draft', 'resolve the question boundary or publication before editing'); }
  async import(file: string) {
    const { reference } = readCandidate(file);
    return this.locked(async () => {
      const all = this.list();
      let d = all.find(x => x.identity === reference.identity);
      if (!d) {
        const family = reference.origin ? all.filter(x => [...x.automatic, ...x.suggestions].some(r => r.origin?.key === reference.origin!.key)) : [];
        // Only the explicit first-registration marker owns the bootstrap batch.
        // UUIDv7 random bits and wall-clock changes do not establish creation
        // order. Missing or conflicting markers cannot open a later batch.
        const batches = new Set(family.flatMap(x => (x.bootstrap_origins ?? []).filter(r => r.key === reference.origin?.key).map(r => r.batch)));
        const bootstrap = batches.size === 1 ? [...batches][0] : undefined;
        const closed = family.some(x => x.origin_closed || x.state !== 'active' || x.predecessors.length || x.successors.length || x.manual.question !== undefined || x.review.status !== 'pending' || x.boundary);
        const legacy = all.filter(x => [...x.automatic, ...x.suggestions].some(r => r.project.id === reference.project.id && r.identity.startsWith('graphkb:') && (!reference.origin || !r.origin)));
        const related = family.length ? family : reference.identity.startsWith('graphkb:') ? legacy : [];
        const pending = Boolean(related.length && (!family.length || closed || bootstrap !== reference.origin?.batch));
        d = { format: 'grounds.qa-draft/v1', id: newUUIDv7(), version: 1, identity: reference.identity, state: pending ? 'boundary_pending' : 'active', automatic: [reference], suggestions: [], manual: {}, review: { status: 'pending', independent_text: false, authority: '', attachments_resolved: false, knowledge: 'unknown' }, predecessors: [], successors: [], lineage: [],
          ...(!family.length && !pending && reference.origin ? {bootstrap_origins: [reference.origin]} : {}),
          ...(pending ? { boundary: { related_drafts: related.map(x => x.id), reason: family.length ? 'origin_repartitioned' : 'legacy_origin_unavailable' } as LocalQADraft['boundary'] } : {}) };
        this.save(d); return d;
      }
      if (reference.origin && [...d.automatic, ...d.suggestions].some(r => r.identity === reference.identity && r.origin && r.origin.key !== reference.origin!.key)) throw validation('origin', 'existing identity belongs to another original message');
      if ([...d.automatic, ...d.suggestions].some(r => r.digest === reference.digest)) return d;
      if([...d.automatic,...d.suggestions].some(r=>r.identity===reference.identity&&r.revision===reference.revision))throw validation('revision','same revision changed; export a new immutable revision');
      d.suggestions.push(reference); d.version++; this.save(d); return d;
    });
  }
  async resolveBoundary(id: string, version: number, decision: {kind: 'new'} | {kind: 'existing'; target: {id: string; version: number}}) {
    record(decision, 'boundary');
    if (!['new', 'existing'].includes(decision.kind) || Object.keys(decision).some(k => !['kind', ...(decision.kind === 'existing' ? ['target'] : [])].includes(k))) throw validation('boundary', 'explicit new or existing target required');
    if (decision.kind === 'existing') {
      record(decision.target, 'boundary.target');
      if (Object.keys(decision.target).some(k => !['id', 'version'].includes(k)) || !Number.isSafeInteger(decision.target.version) || decision.target.version < 1) throw validation('boundary.target', 'exact target id and version required');
    }
    return this.locked(async () => {
      const pending = this.load(id); this.check(pending, version);
      if (pending.state !== 'boundary_pending') throw validation('boundary', 'expected unresolved question boundary');
      const references = [...pending.automatic, ...pending.suggestions];
      references.forEach(r => readCandidate(r.file, r.digest));
      if (decision.kind === 'new') {
        pending.state = 'active'; pending.boundary!.decision = 'new'; pending.version++;
        pending.lineage.push({action: 'confirm_new_boundary', sources: pending.boundary!.related_drafts, at: new Date().toISOString()});
        this.save(pending); return pending;
      }
      if (decision.kind !== 'existing' || !decision.target) throw validation('boundary', 'explicit new or existing target required');
      const target = this.load(decision.target.id); this.check(target, decision.target.version); this.mutable(target);
      for (const r of references) if (![...target.automatic, ...target.suggestions].some(x => x.digest === r.digest)) target.suggestions.push(r);
      target.review.status = 'pending'; target.version++;
      target.lineage.push({action: 'associate_origin_proposal', sources: [pending.identity], at: new Date().toISOString()});
      pending.state = 'replaced'; pending.boundary!.decision = 'existing'; pending.successors = [target.id]; pending.version++;
      pending.lineage.push({action: 'resolve_existing_boundary', sources: [target.identity], at: new Date().toISOString()});
      this.saveMany([pending, target]); return target;
    });
  }
  async edit(id: string, version: number, patch: { qa?: QAContent; review?: DraftReview; }) {
    record(patch,'edit');if(Object.keys(patch).some(k=>!['qa','review'].includes(k)))throw validation('edit','unknown edit field');
    const qa = patch.qa ? content(patch.qa) : undefined;
    if (qa?.source || qa?.format) throw validation('manual', 'source provenance and format cannot be replaced');
    const review = patch.review ? validateReview(patch.review) : undefined;
    return this.locked(async () => { const d = this.load(id); this.check(d, version); this.mutable(d); if (d.review.status !== 'pending' || qa?.question !== undefined || review && review.status !== 'pending') d.origin_closed = true; if (qa) d.manual = { ...d.manual, ...qa }; if (review) d.review = review; else d.review.status = 'pending'; d.version++; this.save(d); return d; });
  }
  view(id: string, now = Date.now()) {
    const d = this.load(id), materials: CandidateHandoff[] = [], missing: string[] = [];
    for (const r of d.automatic) {
      try { if (Date.parse(r.project.expires_at) <= now) throw new Error('expired'); materials.push(readCandidate(r.file, r.digest, now).handoff); }
      catch (e) { missing.push(`${r.identity}@${r.revision}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    const base = materials[0]?.qa ?? d.retained ?? {};const merged={...base,...d.manual,format:'grounds.eval-qa/v1'} as QAContent;if(typeof merged.reference_answer==='string'&&!merged.reference_answer.trim())delete merged.reference_answer;
    return { draft: d, qa: merged, verified_fields:d.review.status==='reviewed'?QA_FIELDS.filter(k=>k in d.manual||k in base):[],provenance: Object.fromEntries(QA_FIELDS.map(k => [k, k in d.manual ? 'human' : k in base ? 'model_suggestion' : 'missing'])), materials, missing };
  }
  async split(id: string, version: number, contents: QAContent[]) {
    if (!Array.isArray(contents) || contents.length < 2 || contents.length > 20) throw validation('split', 'requires 2–20 successors');
    contents.forEach(v => { const q = content(v); if (q.source || q.format) throw validation('split', 'manual source replacement forbidden'); });
    return this.locked(async () => { const old = this.load(id); this.check(old, version); this.mutable(old); const successors = contents.map(q => this.successor([old], q, 'split')); old.state = 'replaced'; old.successors = successors.map(d => d.id); old.version++; this.saveMany([old, ...successors]); return successors; });
  }
  async merge(inputs: { id: string; version: number ;}[], qa: QAContent) {
    content(qa); if (qa.source || qa.format || !Array.isArray(inputs) || inputs.length < 2 || inputs.length > 20 || new Set(inputs.map(x => x.id)).size !== inputs.length) throw validation('merge', 'requires distinct predecessors and editable content');
    return this.locked(async () => { const olds = inputs.map(x => { const d = this.load(x.id); this.check(d, x.version); this.mutable(d); return d; }); const next = this.successor(olds, qa, 'merge'); for (const d of olds) { d.state = 'replaced'; d.successors = [next.id]; d.version++; } this.saveMany([...olds, next]); return next; });
  }
  private successor(olds: LocalQADraft[], qa: QAContent, action: string): LocalQADraft {
    const id = newUUIDv7(); return { format: 'grounds.qa-draft/v1', id, version: 1, identity: `grounds:${id}`, state: 'active', automatic: olds.flatMap(d => d.automatic).filter((r, i, a) => a.findIndex(x => x.digest === r.digest) === i), suggestions: [], manual: {...structuredClone(olds[0].manual),...structuredClone(qa)},...(olds[0].retained?{retained:structuredClone(olds[0].retained)}:{}),retained_packages:olds.flatMap(d=>[...(d.saved?[d.saved]:[]),...(d.retained_packages??[])]).filter((r,i,a)=>a.findIndex(x=>x.digest===r.digest&&x.database_id===r.database_id)===i), review: { status: 'pending', independent_text: false, authority: '', attachments_resolved: false, knowledge: 'unknown' }, predecessors: olds.map(d => d.id), successors: [], lineage: olds.flatMap(d => d.lineage).concat({ action, sources: olds.map(d => d.identity), at: new Date().toISOString() }) };
  }
  async acceptSuggestion(id: string, version: number, digest: string, successorId: string, successorVersion: number) {
    return this.locked(async () => {
      const old = this.load(id); this.check(old, version); if (old.state === 'boundary_pending') throw validation('boundary', 'resolve the original question boundary first'); const r = old.suggestions.find(x => x.digest === digest); if (!r) throw validation('suggestion', 'not found'); readCandidate(r.file, r.digest);
      const next = this.load(successorId); this.check(next, successorVersion); this.mutable(next);
      // Explicit selection only changes model base. Human fields remain authoritative.
      next.origin_closed = true;
      next.automatic = [r, ...next.automatic.filter(x => x.digest !== r.digest)]; next.review.status = 'pending'; next.version++;
      if (next.id === old.id) next.suggestions = next.suggestions.filter(x => x.digest !== digest); else { old.suggestions = old.suggestions.filter(x => x.digest !== digest); old.version++; }
      this.saveMany(next.id === old.id ? [next] : [old, next]); return next;
    });
  }
}
