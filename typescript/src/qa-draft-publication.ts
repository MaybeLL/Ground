import { canonicalBytes, sha256, sha256Bytes } from './canonical-json.js';
import { EvalModule, type EvalWrite } from './eval-module.js';
import { decodeQA, type QADraft } from './eval-qa.js';
import { refValue, decodeGrader, type EvalRecord } from './evaluation.js';
import { DomainError, validation } from './errors.js';
import { validateAttribution } from './domain.js';
import { isSha256, isUUIDv7, newUUIDv7 } from './identity.js';
import { explicitlyUnfinished, requireReadyQA } from './qa-readiness.js';
import { decodeMaterialJSON, QADraftStore, decodeCandidate, readCandidate, validateReview, content, type CandidateHandoff, type DraftTarget, type LocalQADraft, type CandidateJournal, type PublicationStep, type QAContent } from './qa-candidate.js';

export interface SourcePackage { format: 'grounds.qa-source-package/v1'; sources: CandidateHandoff[]; manual: QAContent; review: LocalQADraft['review']; lineage: LocalQADraft['lineage']; retained_from?: string[]; retained_operations?: {digest:string;operation_id:string}[]; }
export interface SourcePackageReference { format: 'grounds.qa-source-package-reference/v1'; digest: string; size: number; evidence: { id: string; locator: string; digest: string; size: number; kind: string; name: string; }[]; }
export class QASourceModule extends EvalModule {
  async replay(operationId: string, expected?: { command: string; input: unknown; attribution: import('./domain.js').Attribution ;}): Promise<unknown | undefined> {
    return this.store.read(async tx => { const operation = await tx.getOperation(operationId); if (operation && expected && (operation.command !== expected.command || operation.request_hash !== sha256({ input: expected.input, attribution: expected.attribution }))) throw validation('operation', 'durable operation differs from fixed input'); return operation ? JSON.parse(operation.result_json).data.payload : undefined; });
  }
  override publishGrader(raw:unknown,actor:EvalWrite,update?:{id:string;expected_version:number}):Promise<EvalRecord<'grader'>>{
    const draft=decodeGrader(raw);if(update||!draft.qa)return super.publishGrader(raw,actor,update);
    return this.write('grader.publish',{draft},actor,async tx=>{await tx.getEvalRecord('qa',draft.qa!.id,draft.qa!.version);const notices=await tx.listEvalRecords('notice');const existing=(await tx.listEvalRecords('grader')).find(g=>sha256(g.data)===sha256(draft)&&!notices.some(n=>n.data.grader.id===g.id&&n.data.grader.version===g.version));return existing??this.save(tx,'grader',draft,actor,undefined,draft.qa!.id);});
  }
  private async retentionReceipt(digest:string,operationId:string):Promise<void>{
    if(!isSha256(digest)||!isUUIDv7(operationId))throw validation('retained_operations','source digest and save operation required');
    const operation=await this.store.read(tx=>tx.getOperation(operationId));
    const result=operation?JSON.parse(operation.result_json):undefined;
    if(operation?.command!=='eval.source-package.save'||result?.ok!==true||result?.data?.command!=='eval.source-package.save'||result?.data?.payload?.format!=='grounds.qa-source-package-reference/v1'||result.data.payload.digest!==digest)
      throw validation('retained_operations','completed source save receipt does not match package');
  }
  async freeze(raw: SourcePackage, actor: EvalWrite, existingOperation?:string): Promise<SourcePackageReference> {
    if (raw.format !== 'grounds.qa-source-package/v1' || !Array.isArray(raw.sources) || !raw.sources.length || raw.sources.length > 100) throw validation('source_package', 'expected bounded source package');
    content(raw.manual); if (raw.manual.source || raw.manual.format) throw validation('manual', 'editable content only');
    refValue({ id: actor.operation_id, version: 1 }); validateAttribution(actor.attribution);
    const committed = await this.replay(actor.operation_id, { command: 'eval.source-package.save', input: { digest: sha256(raw) }, attribution: actor.attribution }); if (committed) return committed as SourcePackageReference;
    const retained: CandidateHandoff[] = [];
    if(existingOperation){await this.retentionReceipt(sha256(raw),existingOperation);retained.push(...(await this.package(sha256(raw))).sources);}
    const receipts = raw.retained_operations ?? [];
    if (!Array.isArray(receipts) || receipts.length > 100) throw validation('retained_operations', 'bounded retention receipts required');
    const proven = new Set<string>();
    for (const ref of receipts) {
      if (!ref || Object.keys(ref).some(k => !['digest', 'operation_id'].includes(k)) || !isSha256(ref.digest) || !isUUIDv7(ref.operation_id)) throw validation('retained_operations', 'source digest and save operation required');
      await this.retentionReceipt(ref.digest,ref.operation_id);
      proven.add(ref.digest);
    }
    if (raw.retained_from&&!existingOperation) {
      if (!Array.isArray(raw.retained_from) || raw.retained_from.length > 100) throw validation('retained_from', 'bounded package references required');
      for (const digest of raw.retained_from) {
        if (!proven.has(digest)) throw validation('retained_from', 'source package needs its completed retention operation');
        retained.push(...(await this.package(digest)).sources);
      }
    }
    // A fixed historical source remains byte-identical when reused. New inputs
    // always pass today's decoder; do not retroactively rewrite an old package's
    // provenance or renew its original automatic-material dates.
    const sources = raw.sources.map(s => { const previouslySaved = retained.find(old => sha256(old) === sha256(s)); return previouslySaved ? structuredClone(previouslySaved) : decodeCandidate(s); }); validateReview(raw.review);
    const pkg = { ...raw, sources }; const bytes = canonicalBytes(pkg);
    if (bytes.length > 32 * 1024 * 1024) throw validation('source_package', '32 MiB maximum');
    return this.write('source-package.save', { digest: sha256Bytes(bytes) }, actor, async tx => {
      const digest = await tx.putEvalBlob(bytes);
      return { format: 'grounds.qa-source-package-reference/v1', digest, size: bytes.length, evidence: sources.flatMap(s => s.evidence.map(e => ({ id: e.id, name: `${s.identity}@${s.revision}#${e.id}`, locator: e.locator, digest: e.digest, size: Buffer.byteLength(e.content), kind: e.kind }))) };
    });
  }
  async package(digest: string): Promise<SourcePackage> {
    if (!isSha256(digest)) throw validation('source_package', 'invalid digest');
    const bytes = await this.store.read(tx => tx.getEvalBlob(digest));
    if (bytes.length > 32 * 1024 * 1024 || sha256Bytes(bytes) !== digest) throw validation('source_package', 'integrity mismatch');
    const pkg = decodeMaterialJSON(bytes) as SourcePackage;
    if (pkg.format !== 'grounds.qa-source-package/v1') throw validation('source_package', 'not a QA source package');
    return pkg;
  }
  async manifest(digest: string): Promise<SourcePackageReference> {
    const p = await this.package(digest); return { format: 'grounds.qa-source-package-reference/v1', digest, size: canonicalBytes(p).length, evidence: p.sources.flatMap(s => s.evidence.map(e => ({ id: e.id, name: `${s.identity}@${s.revision}#${e.id}`, locator: e.locator, digest: e.digest, size: Buffer.byteLength(e.content), kind: e.kind }))) };
  }
  async file(digest: string, identity: string, offset = 0) {
    const p = await this.package(digest), matches = p.sources.flatMap(s => s.evidence.filter(e => (`${s.identity}@${s.revision}#${e.id}`===identity||`${s.identity}#${e.id}` === identity)));
    if (matches.length !== 1) throw validation('evidence', 'identity absent or ambiguous; use qualified source identity');
    const e = matches[0], bytes = Buffer.from(e.content); if (sha256Bytes(bytes) !== e.digest || !Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) throw validation('evidence', 'invalid offset or content');
    const end = Math.min(offset + 65536, bytes.length); return { digest: e.digest, size: bytes.length, offset, next_offset: end < bytes.length ? end : null, encoding: 'base64', content: bytes.subarray(offset, end).toString('base64') };
  }
}
export function target(raw: unknown): DraftTarget {
  const t = raw as DraftTarget; if (!t || typeof t !== 'object') throw validation('target', 'expected publication target');
  if (Object.keys(t).some(k => !['suite', 'template', 'member', 'qa'].includes(k))) throw validation('target', 'unknown target field');
  refValue(t.suite); refValue(t.template); if (t.qa) refValue(t.qa);
  if (!t.member || typeof t.member !== 'object' || Object.keys(t.member).some(k => !['mode', 'id'].includes(k))) throw validation('member', 'invalid member'); if (t.member.id) refValue({ id: t.member.id, version: 1 });
  if (!['add', 'update'].includes(t.member?.mode) || t.member.mode === 'update' && !t.member.id || t.member.mode === 'add' && t.member.id) throw validation('member', 'explicit add or existing member required');
  return structuredClone(t);
}
const reference = (record: EvalRecord) => ({ id: record.id, version: record.version });
function publicationQA(d: LocalQADraft, pkg: SourcePackage, pkgDigest: string): QADraft {
  const source = pkg.sources[0].qa.source;
  if (!source) throw validation('source', 'capture provenance required');
  const automatic = pkg.sources[0].qa;
  const body = { ...automatic, ...pkg.manual, format: 'grounds.eval-qa/v1', source: { ...source, identity: d.identity, record: { kind: 'captured_review', source_package: pkgDigest, captured_sources: pkg.sources.map(s => ({ identity: s.identity, revision: s.revision, provenance: s.qa.source ? { repository:s.qa.source.repository,revision:s.qa.source.revision,path:s.qa.source.path,digest:s.qa.source.digest,record_digest:sha256(s.qa.source.record) } : {}, relations_digest:sha256(s.relations),completeness:s.completeness,limitations_digest:sha256(s.limitations) })), manual_revision: { draft: d.id, version: d.version, fields: Object.keys(pkg.manual) }, lineage_digest:sha256(pkg.lineage),review:{status:pkg.review.status,knowledge:pkg.review.knowledge,authority_digest:sha256(pkg.review.authority),conditions_digest:sha256(pkg.review.answer_conditions??{}),independent_text:pkg.review.independent_text,attachments_resolved:pkg.review.attachments_resolved} } } };
  if(typeof body.reference_answer==='string'&&!body.reference_answer.trim())delete body.reference_answer;
  return decodeQA(body);
}
function copiesHistoricalAnswer(publicText: string, answer: string, locator: string): boolean {
  // A declared source locator, valid date and commit digest are opaque metadata,
  // not an asserted service value. Do not find "10" inside 2026-10-13 or a hash.
  let prose = publicText.split(locator).join(' ');
  // Chinese prose does not delimit dates with spaces; adjoining CJK letters
  // must not expose a month/day component as an asserted numeric answer.
  prose = prose.replace(/(?<![a-zA-Z0-9])\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?(?![a-zA-Z0-9])/gu, date => Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date.slice(0, 10) ? ' ' : date);
  prose = prose.replace(/(?<![a-zA-Z0-9])(?:sha(?:1|256):)?(?:[a-f0-9]{64}|[a-f0-9]{40})(?![a-zA-Z0-9])/gi, ' ');
  const scalar = answer.trim();
  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(scalar)) {
    const percent = scalar.endsWith('%');
    return [...prose.matchAll(/(?<![a-zA-Z0-9_.])[+-]?(?:\d+(?:\.\d+)?|\.\d+)%?(?![a-zA-Z0-9_]|\.\d)/g)].some(([value]) => value.endsWith('%') === percent && Number(value.replace(/%$/, '')) === Number(scalar.replace(/%$/, '')));
  }
  return Boolean(scalar) && prose.includes(scalar);
}
function reviewGate(d: LocalQADraft, pkg: SourcePackage, qa: QADraft) {
  requireReadyQA(qa);
  const r = validateReview(pkg.review);
  if (explicitlyUnfinished(r.authority)) throw validation('review.authority', 'authority explicitly remains unfinished; keep the draft pending and complete the evidence');
  if (d.state !== 'active' || r.status !== 'reviewed' || !r.independent_text || !r.authority.trim() || !r.attachments_resolved) throw validation('review', 'human authority, independent text and resolved attachments required');
  if (r.knowledge === 'unknown') throw validation('review', 'classify stable or historical knowledge');
  if (r.knowledge === 'historical') {
    const c = r.answer_conditions;
    if (!c?.accessible || !c.preserves_question || !c.locator.trim() || !c.instructions.trim() || !qa.instructions.includes(c.instructions)) throw validation('answer_conditions', 'historical conditions require an accessible fixed locator and explicit public instructions preserving the question');
    // The historical visible answer is private even when the optional reviewed
    // reference answer was never supplied or was explicitly cleared.
    const answers = new Set([qa.reference_answer, ...pkg.sources.flatMap(source =>
      source.evidence.filter(evidence => evidence.kind === 'answer').map(evidence => evidence.content))]
      .filter((answer): answer is string => typeof answer === 'string' && Boolean(answer.trim())));
    if ([...answers].some(answer => [qa.question, qa.instructions].some(text => copiesHistoricalAnswer(text, answer, c.locator)))) throw validation('answer_conditions', 'historic reference or visible answer cannot replace a retrieval question');
  }
  for (const kind of ['question', 'query', 'answer']) if (!pkg.sources.some(s=>s.evidence.some(e => e.kind === kind && e.content.trim().length > 0)&&['complete','partial'].includes(s.completeness[kind]))) throw validation('materials', `critical ${kind} evidence needs an observable nonblank body and covered completeness across selected sources`);
  // This gate is review evidence, not a semantic theorem or a claim that future environments are pinned.
}
export class QADraftPublisher {
  constructor(readonly drafts: QADraftStore, readonly module: QASourceModule, readonly databaseId: string) { }
  private sourceOperation(d:LocalQADraft,digest:string):string|undefined{
    const ref=[...(d.saved?[d.saved]:[]),...(d.retained_packages??[])].find(r=>r.digest===digest);
    const saved=d.source_saves?.find(s=>(s.result as SourcePackageReference|undefined)?.digest===digest);
    const step=[...(d.journal?[d.journal]:[]),...(d.publication_history??[])].flatMap(j=>j.steps).find(s=>s.name==='source'&&s.status==='completed'&&(s.result as SourcePackageReference)?.digest===digest);
    return ref?.operation_id??saved?.operation_id??step?.operation_id;
  }
  private async packageFor(d: LocalQADraft): Promise<SourcePackage> {
    const references=[...(d.saved?[d.saved]:[]),...(d.retained_packages??[])].filter((r,i,a)=>a.findIndex(x=>x.digest===r.digest&&x.database_id===r.database_id)===i);
    if(references.length){
      const fixed:CandidateHandoff[]=[];for(const ref of references){if(ref.database_id!==this.databaseId)throw validation('database_id','retained sources belong to another ledger');const p=await this.module.package(ref.digest);for(const s of p.sources){const found=fixed.find(x=>x.identity===s.identity&&x.revision===s.revision);if(found&&sha256(found)!==sha256(s))throw validation('source','conflicting immutable source revisions');if(!found)fixed.push(s);}}
      const sources:CandidateHandoff[]=[];for(const r of d.automatic){const saved=fixed.find(s=>s.identity===r.identity&&s.revision===r.revision);sources.push(saved??readCandidate(r.file,r.digest).handoff);}
      for(const saved of fixed)if(!sources.some(s=>s.identity===saved.identity&&s.revision===saved.revision))sources.push(saved);
      if(d.saved){const prior=await this.module.package(d.saved.digest);if(sha256(prior.sources)===sha256(sources)&&sha256(prior.manual)===sha256(d.manual)&&sha256(prior.review)===sha256(d.review)&&sha256(prior.lineage)===sha256(d.lineage))return prior;}
      const retained_operations=references.map(r=>{
        const operation_id=this.sourceOperation(d,r.digest);
        if(!operation_id)throw validation('retained_from','completed retention operation is missing; recover the original save');
        return {digest:r.digest,operation_id};
      });
      return {format:'grounds.qa-source-package/v1',sources,manual:d.manual,review:d.review,lineage:d.lineage,retained_from:references.map(r=>r.digest),retained_operations};
    }
    const v = this.drafts.view(d.id); if (v.missing.length || !v.materials.length) throw validation('materials', v.missing.join('; ') || 'no source materials');
    return { format: 'grounds.qa-source-package/v1', sources: v.materials, manual: d.manual, review: d.review, lineage: d.lineage };
  }
  async saveSource(id: string, version: number, actor: EvalWrite) {    
refValue({ id: actor.operation_id, version: 1 }); validateAttribution(actor.attribution); return this.drafts.locked(async () => {
      const d = this.drafts.load(id); let request = d.source_saves?.find(x => x.operation_id === actor.operation_id), pkg: SourcePackage | undefined;
      if (request) { if (request.database_id !== this.databaseId) throw validation('database_id', 'source save belongs to another ledger'); if (request.expected_version !== version || sha256(request.attribution) !== sha256(actor.attribution)) throw validation('operation', 'source save replay changed'); if (request.result) return { draft: d, source_package: request.result }; }
      else { this.drafts.check(d, version); this.drafts.mutable(d); pkg = await this.packageFor(d); request = { operation_id: actor.operation_id, database_id: this.databaseId, expected_version: version, input: { digest: sha256(pkg) }, attribution: actor.attribution }; d.source_saves = [...(d.source_saves ?? []), request]; this.drafts.save(d); }
      const replay = await this.module.replay(actor.operation_id, { command: 'eval.source-package.save', input: request.input, attribution: actor.attribution });
      if (!replay) { pkg ??= await this.packageFor(d); if (sha256(pkg) !== request.input.digest) throw validation('materials', 'source save fixed input changed'); }
      const result = (replay ?? await this.module.freeze(pkg!, actor, this.sourceOperation(d,sha256(pkg!)))) as SourcePackageReference;
      request.result = result; d.saved = { digest: result.digest, database_id: this.databaseId, operation_id: actor.operation_id }; d.retained = (await this.module.package(result.digest)).sources[0].qa; d.version++; this.drafts.save(d); return { draft: d, source_package: result };
    });  
}
  async preview(id: string, version: number, rawTarget: unknown) {
    const d = this.drafts.load(id); this.drafts.check(d, version); const selected = target(rawTarget);
    if (d.state !== 'active') throw validation('draft', 'predecessor replaced, choose a successor');
    if (d.journal && !['published', 'cancelled', 'conflict'].includes(d.journal.state)) throw validation('publication', 'result pending; resume the original journal');
    const suite = await this.module.show('suite', selected.suite.id);
    if (suite.version !== selected.suite.version) throw validation('suite', 'selected version is stale; preview latest explicitly');
    if (selected.member.mode === 'update' && !suite.data.tasks.some(t => t.id === selected.member.id)) throw validation('member', 'member deleted; choose another member or explicitly add');
    const template = await this.module.show('grader', selected.template.id, selected.template.version);
    if (template.data.definition.type !== 'agent' || template.data.result_spec.kind !== 'qa_decision' || template.data.scope.kind !== 'diagnostic') throw validation('template', 'select a QA Agent template at an exact version');
    if (d.journal?.state === 'conflict') {
      const j = d.journal; if (j.database_id !== this.databaseId || sha256(j.target.template) !== sha256(selected.template) || sha256(j.target.qa ?? null) !== sha256(selected.qa ?? null) || j.target.suite.id !== selected.suite.id) throw validation('target', 'conflict recovery only retargets a member in the original suite');
      const token = sha256({ draft: d.id, version: d.version, journal: j.id, target: selected, suite, template, database_id: this.databaseId });
      return { format: 'grounds.qa-draft-preview/v1', digest: token, draft_id: d.id, draft_version: d.version, database_id: this.databaseId, qa: j.qa, review: d.review, target: selected, template, suite, source_package: j.steps.find(s => s.name === 'source')?.result, conflict: { previous_target: j.target, previous_step: j.steps.at(-1) }, public_input: { question: j.qa?.question, instructions: j.qa?.instructions } };
    }
    const pkg = await this.packageFor(d), pkgDigest = sha256(pkg), qa = publicationQA(d, pkg, pkgDigest); reviewGate(d, pkg, qa);
    if(!selected.qa&&(await this.module.list('qa')).some(q=>q.data.source.identity===d.identity))throw validation('qa','source already published; explicitly select its current QA version');
    if (selected.qa) { const previous = await this.module.show('qa', selected.qa.id); if (previous.version !== selected.qa.version || previous.data.source.identity !== d.identity) throw validation('qa', 'explicit latest QA revision with same stable source identity required'); }
    const token = sha256({ draft: d.id, version: d.version, qa, pkg_digest: pkgDigest, target: selected, suite, template, database_id: this.databaseId });
    return { format: 'grounds.qa-draft-preview/v1', digest: token, draft_id: d.id, draft_version: d.version, database_id: this.databaseId, qa, review: d.review, target: selected, template, suite, source_package: { digest: pkgDigest, evidence: pkg.sources.flatMap(s => s.evidence.map(({ content, ...e }) => ({ ...e, size: Buffer.byteLength(content) }))) }, public_input: { question: qa.question, instructions: qa.instructions }, limitations: pkg.sources.flatMap(s => s.limitations) };
  }
  async publish(id: string, version: number, rawTarget: unknown, confirmed: string, actor: EvalWrite) {    
refValue({ id: actor.operation_id, version: 1 }); validateAttribution(actor.attribution); return this.drafts.locked(async () => {
      const original = this.drafts.load(id); const replay = [original.journal, ...(original.publication_history ?? [])].find(j => j?.id === actor.operation_id);
      if (replay) { if (replay.preview_digest !== confirmed || sha256(replay.target) !== sha256(target(rawTarget)) || sha256(replay.attribution) !== sha256(actor.attribution)) throw validation('operation', 'publication replay input changed'); if (replay !== original.journal) return { ...original, journal: replay }; return this.advance(original); }
      const preview = await this.preview(id, version, rawTarget); if (preview.digest !== confirmed) throw validation('confirmation', 'preview changed; preview and confirm again');
      const d = this.drafts.load(id), selected = target(rawTarget);
      if (d.journal?.state === 'conflict') {
        const old = d.journal.steps.at(-1)!; if (old.name !== 'suite' || old.status !== 'rejected' || await this.module.replay(old.operation_id) !== undefined) throw validation('recovery', 'old step not proved uncommitted');
        d.journal.target = selected; d.journal.preview_digest = confirmed; d.journal.state = 'partial';
        // Old immutable failed step is retained. New operation is allocated by advance.
      } else { if (d.journal) d.publication_history = [...(d.publication_history ?? []), d.journal]; d.journal = { id: actor.operation_id, database_id: this.databaseId, attribution: actor.attribution, preview_digest: confirmed, target: selected, steps: [], state: 'pending' }; }
      this.drafts.save(d); return this.advance(d);
    });  
}
  async resume(id: string) { const snapshot = this.drafts.load(id), pendingSource = snapshot.source_saves?.find(s => !s.result); if (pendingSource) return (await this.saveSource(id, pendingSource.expected_version, { operation_id: pendingSource.operation_id, attribution: pendingSource.attribution })).draft; return this.drafts.locked(async () => { const d = this.drafts.load(id); if (!d.journal || d.journal.database_id !== this.databaseId) throw validation('publication', 'missing journal or wrong ledger'); if (d.journal.state === 'conflict') throw validation('publication', 'conflict requires a new preview and explicit confirmation'); return this.advance(d); }); }
  async cancel(id: string, version: number) { return this.drafts.locked(async () => { const d = this.drafts.load(id); this.drafts.check(d, version); if (d.source_saves?.some(s => !s.result) || d.journal?.steps.some(s => s.status === 'pending')) throw validation('cancel', 'result unknown; recover before cancellation'); if (d.journal) d.journal.state = 'cancelled'; d.version++; this.drafts.save(d); return d; }); }
  private async step(d: LocalQADraft, name: PublicationStep['name'], input: unknown, fn: (actor: EvalWrite) => Promise<unknown>) {
    const j = d.journal!, last = j.steps.filter(s => s.name === name).at(-1); if (last?.status === 'completed') return last.result;
    const hash = sha256(input); if (last?.status === 'pending' && last.input_digest !== hash) throw validation('operation', 'fixed step input changed');
    const s = last?.status === 'pending' ? last : { name, operation_id: newUUIDv7(), input_digest: hash, input: structuredClone(input), status: 'pending' as const, ...(last ? { replaces: last.operation_id } : {}) };
    if (s !== last) j.steps.push(s); j.state = 'partial'; this.drafts.save(d);
    try {
      const replay = await this.module.replay(s.operation_id, this.operationInput(s, j)); const result = replay ?? await fn({ operation_id: s.operation_id, attribution: j.attribution }); s.result = result; s.status = 'completed'; delete s.error; this.drafts.save(d); return result;
    } catch (e) {
      s.error = e instanceof DomainError ? { code: e.code, details: e.details, message: e.message } : { code: 'UNKNOWN', message: e instanceof Error ? e.message : String(e) };
      if (e instanceof DomainError && ['VALIDATION_ERROR', 'VERSION_CONFLICT', 'NOT_FOUND'].includes(e.code)) { s.status = 'rejected'; j.state = name === 'suite' ? 'conflict' : 'partial'; }
      this.drafts.save(d); throw e;
    }
  }
  private operationInput(s: PublicationStep, j: CandidateJournal) {
    if (sha256(s.input) !== s.input_digest) throw validation('operation', 'saved step input digest mismatch');
    const i = s.input as any; let command: string, input: unknown;
    if (s.name === 'source') { command = 'eval.source-package.save'; input = i; }
    else if (s.name === 'qa') { command = 'eval.qa.publish'; input = { draft: decodeQA(i.qa), ...(i.update ? { update: { id: i.update.id, expected_version: i.update.version } } : {}) }; }
    else if (s.name === 'grader') { command = 'eval.grader.publish'; input = { draft: decodeGrader(i) }; }
    else { command = `eval.suite.task.${i.member.mode}`; input = { suiteId: i.target.id, expected: i.target.version, type: i.member.mode, task: i.task, ...(i.member.id ? { task_id: i.member.id } : {}) }; }
    return { command, input, attribution: j.attribution };
  }
  private async advance(d: LocalQADraft): Promise<LocalQADraft> {
    const j = d.journal!; if (j.state === 'published' || j.state === 'cancelled') return d;
    const existingSource = j.steps.find(s => s.name === 'source'); let pkg: SourcePackage | undefined;
    // If a source receipt was lost, inspect the durable operation before touching an expired cache.
    const replay = existingSource?.status === 'pending' ? await this.module.replay(existingSource.operation_id, this.operationInput(existingSource, j)) : undefined;
    if (replay) { existingSource!.result = replay; existingSource!.status = 'completed'; this.drafts.save(d); }
    if (existingSource?.status !== 'completed') pkg = await this.packageFor(d);
    const source = await this.step(d, 'source', existingSource?.status === 'completed' ? { digest: (existingSource.result as SourcePackageReference).digest } : { digest: sha256(pkg) }, a => this.module.freeze(pkg!, a,this.sourceOperation(d,sha256(pkg!)))) as SourcePackageReference;
    pkg = await this.module.package(source.digest);
    d.saved = { digest: source.digest, database_id: this.databaseId, operation_id: j.steps.find(s=>s.name==='source'&&s.status==='completed')!.operation_id }; d.retained = pkg.sources[0].qa; this.drafts.save(d);
    if (!j.qa) { j.qa = publicationQA(d, pkg, source.digest); j.template = (await this.module.show('grader', j.target.template.id, j.target.template.version)).data as unknown as Record<string, unknown>; this.drafts.save(d); }
    const qa = await this.step(d, 'qa', { qa: j.qa, update: j.target.qa ?? null }, a => this.module.publishQA(j.qa, a, j.target.qa ? { id: j.target.qa.id, expected_version: j.target.qa.version } : undefined)) as EvalRecord<'qa'>;
    const graderBody = { ...j.template, qa: reference(qa) }; delete (graderBody as any).issue;
    const grader = await this.step(d, 'grader', graderBody, a => this.module.publishGrader(graderBody, a)) as EvalRecord<'grader'>;
    const task = { kind: 'qa', name: qa.data.name, qa: reference(qa), graders: [reference(grader)] };
    await this.step(d, 'suite', { target: j.target.suite, member: j.target.member, task }, a => this.module.changeTask(j.target.suite.id, j.target.suite.version, { type: j.target.member.mode, task, ...(j.target.member.id ? { task_id: j.target.member.id } : {}) }, a));
    j.state = 'published'; d.saved = { digest: source.digest, database_id: this.databaseId, operation_id: j.steps.find(s=>s.name==='source'&&s.status==='completed')!.operation_id }; d.retained = pkg.sources[0].qa; this.drafts.save(d); return d;
  }
}
