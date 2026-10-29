import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './canonical-json.js';
import { isSha256 } from './identity.js';
import { validation, versionConflict } from './errors.js';
import { atomicPrivateWrite, privateDirectory, safeRead } from './runtime-files.js';
import { decodeMaterialJSON, QADraftStore } from './qa-candidate.js';

export interface SourceClue {
  id: string; project_id: string; host: string; session: string; branch: string;
  reason: string; state: 'pending_analysis';
  record_ref: { id: string; kind: string; digest: string };
  first_captured_at: string; expires_at: string; limitations: string[];
}
export interface SourceCluePacket {
  format: 'grounds.source-clue/v1'; project: { id: string; root: string }; clues: SourceClue[];
}
interface StoredClue {
  format: 'grounds.source-clue-record/v1'; id: string; version: number;
  project: SourceCluePacket['project']; source: SourceClue; ignored: boolean;
}
export type ClueView = StoredClue & { state: 'pending_analysis' | 'expired' | 'ignored' };
function object(value: unknown, keys: string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw validation(field, 'invalid metadata fields');
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, max = 1024, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || Buffer.byteLength(value) > max) throw validation(field, 'bounded metadata required');
  return value;
}
function time(value: unknown, field: string): string {
  const s = text(value, field, 128);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 19) !== s.slice(0, 19)) throw validation(field, 'RFC3339 UTC required');
  return s;
}
export function decodeSourceClues(raw: unknown): SourceCluePacket {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '') > 1024 * 1024) throw validation('clues', 'metadata packet exceeds 1 MiB');
  const p = object(raw, ['format', 'project', 'clues'], 'clues');
  if (p.format !== 'grounds.source-clue/v1') throw validation('format', 'expected grounds.source-clue/v1');
  const project = object(p.project, ['id', 'root'], 'project');
  const id = text(project.id, 'project.id'), root = text(project.root, 'project.root', 4096);
  if (!Array.isArray(p.clues) || p.clues.length > 1000) throw validation('clues', 'at most 1000 metadata records');
  const seen = new Set<string>();
  const clues = p.clues.map(rawClue => {
    const c = object(rawClue, ['id', 'project_id', 'host', 'session', 'branch', 'reason', 'state', 'record_ref', 'first_captured_at', 'expires_at', 'limitations'], 'clue');
    const clueId = text(c.id, 'clue.id'), projectId = text(c.project_id, 'project_id');
    if (seen.has(clueId) || projectId !== id || c.state !== 'pending_analysis') throw validation('clue', 'duplicate ID, wrong project or incompatible state');
    seen.add(clueId);
    const ref = object(c.record_ref, ['id', 'kind', 'digest'], 'record_ref');
    if (!isSha256(ref.digest)) throw validation('record_ref.digest', 'sha256 required');
    const first = time(c.first_captured_at, 'first_captured_at'), expires = time(c.expires_at, 'expires_at');
    if (Date.parse(expires) <= Date.parse(first) || Date.parse(expires) - Date.parse(first) > 7 * 86400000 || Date.parse(first) > Date.now()) throw validation('clue', 'original capture lifespan must be at most seven days');
    if (!Array.isArray(c.limitations) || c.limitations.length > 100) throw validation('limitations', 'bounded metadata list required');
    return { id: clueId, project_id: projectId, host: text(c.host, 'host', 128), session: text(c.session, 'session'), branch: text(c.branch, 'branch', 1024, true), reason: text(c.reason, 'reason'), state: 'pending_analysis' as const, record_ref: { id: text(ref.id, 'record_ref.id'), kind: text(ref.kind, 'record_ref.kind', 128), digest: String(ref.digest) }, first_captured_at: first, expires_at: expires, limitations: c.limitations.map(v => text(v, 'limitation', 4096)) };
  });
  return { format: 'grounds.source-clue/v1', project: { id, root }, clues };
}

/** Metadata only: never read record_ref bodies and never create an evaluation QA. */
export class SourceClueStore {
  readonly directory: string;
  constructor(readonly drafts: QADraftStore) { this.directory = join(drafts.root, 'clues'); }
  private path(id: string) { text(id, 'id'); return join(this.directory, sha256(id).slice(7) + '.json'); }
  private read(id: string): StoredClue {
    const c = decodeMaterialJSON(safeRead(this.path(id), 1024 * 1024)) as StoredClue;
    if (c.format !== 'grounds.source-clue-record/v1' || c.id !== id || !Number.isSafeInteger(c.version) || c.version < 1 || typeof c.ignored !== 'boolean') throw validation('clue', 'invalid local metadata');
    return c;
  }
  private view(c: StoredClue): ClueView { return { ...c, state: c.ignored ? 'ignored' : Date.parse(c.source.expires_at) <= Date.now() ? 'expired' : 'pending_analysis' }; }
  private save(c: StoredClue) { privateDirectory(this.directory); atomicPrivateWrite(this.path(c.id), JSON.stringify(c)); }
  async import(raw: unknown) {
    const p = decodeSourceClues(raw);
    return this.drafts.locked(async () => {
      privateDirectory(this.directory);
      // Validate every collision before adding any new metadata; retry is idempotent.
      const records = p.clues.map(source => {
        if (existsSync(this.path(source.id))) {
          const existing = this.read(source.id);
          if (sha256(existing.source) !== sha256(source) || sha256(existing.project) !== sha256(p.project)) throw validation('clue', 'immutable clue ID changed; hand off a distinct source record');
          return existing;
        }
        return { format: 'grounds.source-clue-record/v1' as const, id: source.id, version: 1, project: p.project, source, ignored: false };
      });
      records.forEach(c => this.save(c));
      return { format: 'grounds.source-clue-import/v1', project_id: p.project.id, clues: records.map(c => this.view(c)) };
    });
  }
  async list(filter: { project?: string; state?: string; host?: string; limit: number; cursor?: string }) {
    if (!Number.isSafeInteger(filter.limit) || filter.limit < 1 || filter.limit > 1000 || filter.state && !['pending_analysis', 'expired', 'ignored'].includes(filter.state)) throw validation('filter', 'invalid state or limit');
    return this.drafts.locked(async () => {
      privateDirectory(this.directory);
      const clues = readdirSync(this.directory).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => decodeMaterialJSON(safeRead(join(this.directory, n), 1024 * 1024)) as StoredClue).map(c => this.view(this.read(c.id))).filter(c => (!filter.project || c.project.id === filter.project) && (!filter.state || c.state === filter.state) && (!filter.host || c.source.host === filter.host) && (!filter.cursor || c.id > filter.cursor)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return { format: 'grounds.source-clue-list/v1', clues: clues.slice(0, filter.limit), next_cursor: clues.length > filter.limit ? clues[filter.limit - 1].id : null };
    });
  }
  async show(id: string) { return this.drafts.locked(async () => this.view(this.read(id))); }
  async ignore(id: string, version: number) {
    return this.drafts.locked(async () => { const c = this.read(id); if (c.version !== version) throw versionConflict('source_clue', id, version, c.version); if (!c.ignored) { c.ignored = true; c.version++; this.save(c); } return this.view(c); });
  }
}
