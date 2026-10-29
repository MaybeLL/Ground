import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { ParsedArgs } from './cli.js';
import { validation } from './errors.js';
import { safeRead } from './runtime-files.js';
import { versionValue } from './evaluation.js';
import { decodeMaterialJSON, QADraftStore } from './qa-candidate.js';
import { QADraftPublisher, QASourceModule, type SourcePackage } from './qa-draft-publication.js';
import type { Store } from './store-types.js';
import type { Attribution } from './domain.js';
import { SourceClueStore } from './source-clue.js';

const rules: Record<string, { options: string[]; ids: number; ledger?: boolean; write?: boolean ;}> = {
  import: { options: ['file'], ids: 0 }, list: { options: ['state', 'project', 'limit', 'cursor'], ids: 0 }, show: { options: [], ids: 1 },
  evidence: { options: ['name', 'offset'], ids: 1 }, status: { options: [], ids: 1 },
  edit: { options: ['file', 'expected-version'], ids: 1 }, split: { options: ['file', 'expected-version'], ids: 1 },
  merge: { options: ['file'], ids: 0 }, 'route-suggestion': { options: ['file', 'expected-version'], ids: 1 },
  'resolve-boundary': { options: ['file', 'expected-version'], ids: 1 },
  preview: { options: ['file', 'expected-version'], ids: 1, ledger: true },
  'export-public': { options: ['out'], ids: 1, ledger: true },
  publish: { options: ['file', 'expected-version', 'confirm-digest'], ids: 1, ledger: true, write: true },
  resume: { options: [], ids: 1, ledger: true },
  cancel: { options: ['expected-version'], ids: 1, ledger: true },
  'save-source': { options: ['expected-version'], ids: 1, ledger: true, write: true },
};
const sourceRules: typeof rules = { save: { options: ['file'], ids: 0, write: true, ledger: true }, show: { options: [], ids: 1, ledger: true }, file: { options: ['name', 'offset'], ids: 1, ledger: true }, export: { options: ['out'], ids: 1, ledger: true } };
const clueRules: typeof rules = { import: { options: ['file'], ids: 0 }, list: { options: ['project', 'state', 'host', 'limit', 'cursor'], ids: 0 }, show: { options: [], ids: 1 }, ignore: { options: ['expected-version'], ids: 1 } };
export const isQADraftCommand = (a: ParsedArgs) => a.positionals[0] === 'eval' && ['draft', 'source-package', 'clue'].includes(a.positionals[1]);
const rule = (a: ParsedArgs) => (a.positionals[1] === 'draft' ? rules : a.positionals[1] === 'clue' ? clueRules : sourceRules)[a.positionals[2]];
export const qaDraftNeedsLedger = (a: ParsedArgs) => Boolean(rule(a)?.ledger);
export const qaDraftNeedsOperation = (a: ParsedArgs) => Boolean(rule(a)?.write);
export const qaDraftHelp = () => Object.entries(rules).map(([k, r]) => `grounds eval draft ${k}${r.ids ? ' ID' : ''}${r.options.map(o => ` --${o} VALUE`).join('')}`).concat(Object.entries(sourceRules).map(([k, r]) => `grounds eval source-package ${k}${r.ids ? ' DIGEST' : ''}${r.options.map(o => ` --${o} VALUE`).join('')}`), Object.entries(clueRules).map(([k, r]) => `grounds eval clue ${k}${r.ids ? ' ID' : ''}${r.options.map(o => ` --${o} VALUE`).join('')}`)).join('\n') + '\nDraft import/list/show/edit/split/merge/route-suggestion/resolve-boundary and clue commands are local-only (no configured SQL connection required). Clues contain metadata only, expire by original capture time, and never create QA; run graphkb CLI offline analysis separately. --draft-root PATH selects local authoritative storage. Publication is explicit preview + --confirm-digest SHA256; all exact versions and target ledger are visible. Source save and publish are explicit long-term retention; importing or editing is not. Same-origin discoveries after the first batch await explicit new/existing boundary review; pending boundaries cannot be edited, split, merged or published. No model or evaluation is started.';
export function validateQADraftArgs(a: ParsedArgs) {
  const r = rule(a); if (!r || a.positionals.length !== 3 + r.ids) throw validation('command', 'unknown or malformed QA draft command');
  const allowed = new Set(['json', 'cwd', 'config', 'draft-root', ...r.options, ...(r.write ? ['operation-id', 'agent-id', 'agent-name'] : [])]);
  for (const [k, v] of Object.entries(a.values)) { if (!allowed.has(k) || Array.isArray(v)) throw validation(k, 'invalid or repeated draft option'); if (k !== 'json' && (typeof v !== 'string' || !v.trim())) throw validation(k, 'requires a value'); }
}
export async function executeQADraft(a: ParsedArgs, cwd: string, store?: Store, databaseId?: string, attribution?: () => Attribution) {
  validateQADraftArgs(a); const action = a.positionals[2], id = a.positionals[3];
  const v = (k: string, required = true) => { const x = a.values[k]; if (typeof x === 'string' && x.trim()) return x; if (required) throw validation(k, 'required'); return ''; };
  const read = () => decodeMaterialJSON(safeRead(resolve(cwd, v('file')), 32 * 1024 * 1024)) as any;
  const version = () => versionValue(Number(v('expected-version')));
  const drafts = new QADraftStore(v('draft-root', false) || undefined);
  const module = store ? new QASourceModule(store) : undefined;
  const publisher = module && databaseId ? new QADraftPublisher(drafts, module, databaseId) : undefined;
  const actor = () => ({ operation_id: v('operation-id'), attribution: attribution!() });
  let payload: unknown;
  if (a.positionals[1] === 'clue') {
    const clues = new SourceClueStore(drafts);
    if (action === 'import') payload = await clues.import(read());
    else if (action === 'show') payload = await clues.show(id);
    else if (action === 'ignore') payload = await clues.ignore(id, version());
    else payload = await clues.list({ project: v('project', false), state: v('state', false), host: v('host', false), limit: Number(v('limit', false) || 100), cursor: v('cursor', false) });
  } else if (a.positionals[1] === 'source-package') {
    if (action === 'save') payload = await module!.freeze(read() as SourcePackage, actor());
    else if (action === 'show') payload = await module!.manifest(id);
    else if (action === 'file') payload = await module!.file(id, v('name'), Number(v('offset', false) || 0));
    else { const p = await module!.package(id), out = resolve(cwd, v('out')); mkdirSync(out, { mode: 0o700 }); writeFileSync(join(out, 'source-package.json'), JSON.stringify(p, null, 2), { mode: 0o600, flag: 'wx' }); payload = { source_package: await module!.manifest(id), directory: out }; }
  } else if (action === 'import') payload = await drafts.import(resolve(cwd, v('file')));
  else if (action === 'list') payload = await drafts.locked(async () => {
    if(v('state',false)&&!['active','replaced','boundary_pending'].includes(v('state')))throw validation('state','expected active, replaced or boundary_pending');
    const limit = Number(v('limit', false) || 100); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw validation('limit', '1–1000');
    const matching = drafts.list().filter(d => (!v('state', false) || d.state === v('state')) && (!v('project', false) || d.automatic.some(r => r.project.id === v('project'))) && (!v('cursor', false) || d.id > v('cursor')));
    return { format: 'grounds.qa-draft-list/v1', drafts: matching.slice(0, limit).map(d => ({ id: d.id, version: d.version, identity: d.identity, state: d.state, review: { status: d.review.status, knowledge: d.review.knowledge }, project_ids: [...new Set(d.automatic.map(r => r.project.id))], suggestion_count: d.suggestions.length, publication_state: d.journal?.state ?? 'not_started' })), next_cursor: matching.length > limit ? matching[limit - 1].id : null };
  });
  else if (action === 'show') payload = await drafts.locked(async () => { const view = drafts.view(id); return { ...view, materials: view.materials.map(({ format, qa, evidence, relations, extraction, ...s }) => ({ ...s, format: 'grounds.qa-material-index/v1', evidence: evidence.map(({ content, ...e }) => ({ ...e, name: `${s.identity}@${s.revision}#${e.id}`, size: Buffer.byteLength(content) })) })) }; });
  else if (action === 'status') { const d = drafts.load(id); payload = { format: 'grounds.qa-draft-status/v1', draft_id: d.id, draft_version: d.version, state: d.state, publication_state: d.journal?.state ?? 'not_started', ...(d.journal ? { journal_id: d.journal.id, steps: d.journal.steps.map(s => ({ name: s.name, status: s.status, operation_id: s.operation_id, ...(s.error ? { error: s.error } : {}) })) } : {}), source_save_pending: Boolean(d.source_saves?.some(s => !s.result)) }; }
  else if (action === 'evidence') payload = await drafts.locked(async () => {
    const view = drafts.view(id), name = v('name'), found = view.materials.flatMap(s => s.evidence.filter(e => (`${s.identity}@${s.revision}#${e.id}`===name||`${s.identity}#${e.id}` === name))); if (found.length !== 1) throw validation('materials', 'evidence missing, expired or ambiguous');
    const e = found[0], bytes = Buffer.from(e.content), offset = Number(v('offset', false) || 0); if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) throw validation('offset', 'invalid offset'); const end = Math.min(offset + 65536, bytes.length);
    return { digest: e.digest, size: bytes.length, offset, next_offset: end < bytes.length ? end : null, encoding: 'base64', content: bytes.subarray(offset, end).toString('base64') };
  });
  else if (action === 'edit') payload = await drafts.edit(id, version(), read());
  else if (action === 'split') payload = await drafts.split(id, version(), read().successors);
  else if (action === 'merge') { const input = read(); payload = await drafts.merge(input.predecessors, input.qa); }
  else if (action === 'route-suggestion') { const input = read(); payload = await drafts.acceptSuggestion(id, version(), input.digest, input.target.id, input.target.version); }
  else if (action === 'resolve-boundary') payload = await drafts.resolveBoundary(id, version(), read());
  else if (action === 'export-public') {
    const d=drafts.load(id),published=d.journal?.steps.find(s=>s.name==='qa'&&s.status==='completed')?.result as any;
    if(!published?.id)throw validation('qa','no confirmed QA publication receipt');
    const qa=await module!.show('qa',published.id,published.version);
    const packet={format:'grounds.eval-public-question/v1',qa:{id:qa.id,version:qa.version},question:qa.data.question,instructions:qa.data.instructions};
    writeFileSync(resolve(cwd,v('out')),JSON.stringify(packet,null,2)+'\n',{mode:0o600,flag:'wx'});payload=packet;
  }
  else if (action === 'preview') payload = await publisher!.preview(id, version(), read());
  else if (action === 'publish') payload = await publisher!.publish(id, version(), read(), v('confirm-digest'), actor());
  else if (action === 'resume') payload = await publisher!.resume(id);
  else if (action === 'cancel') payload = await publisher!.cancel(id, version());
  else if (action === 'save-source') payload = await publisher!.saveSource(id, version(), actor());
  return { result_type: 'patchledger.result.eval/v1', command: `eval.${a.positionals[1]}.${action}`, payload };
}
