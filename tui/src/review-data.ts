import type { Reader } from './client.js';
import { ClientError, type Data } from './protocol.js';
import { record } from './pages.js';
import { objects, text } from './review-model.js';
import { loadCandidateArchiveStatus } from './candidate-history.js';

/** A report session pins candidate/tree/set identities; new reports require an explicit refresh. */
export class ReviewSession {
  reports: Data[] = [];
  private entries: Data[] = [];
  private cursor?: string;
  private cursors = new Set<string>();
  private seen = new Set<string>();
  private started = false;
  private loading = false;
  private reportBytes = 0;
  constructor(readonly trace: Data, private reader: Reader) {}
  static async open(reader: Reader, candidate: string, signal?: AbortSignal): Promise<ReviewSession> {
    const data = await reader.query('review', [candidate, '--summary', '--include-diff'], signal);
    const trace = record(data.trace);
    if (record(trace.candidate).candidate_id !== candidate) throw new ClientError('PROTOCOL_ERROR', '候选身份不匹配');
    if (record(trace.artifact).git_artifact) {
      trace.archive_status = await loadCandidateArchiveStatus(reader, candidate, record(trace.artifact).git_artifact, signal);
    }
    return new ReviewSession(trace, reader);
  }
  get count(): number { return Number(record(this.trace.verification_set).count); }
  get hasMore(): boolean { return this.reports.length < this.count; }
  async next(signal?: AbortSignal): Promise<void> {
    if (!this.hasMore || this.loading) return;
    this.loading = true;
    try {
      const candidate = text(record(this.trace.candidate).candidate_id);
      if (!this.started) {
        const collected: Data[] = [];
        do {
          const args = ['--candidate', candidate, '--paged', ...(this.cursor ? ['--cursor', this.cursor] : [])];
          const page = await this.reader.query('verifications', args, signal);
          if (page.candidate_id !== candidate || record(page.verification_set).digest !== record(this.trace.verification_set).digest || record(page.verification_set).count !== this.count)
            throw new ClientError('STALE_VERIFICATION_SET', '报告集合已变化，请刷新候选后重新读取');
          const entries = objects(page.verifications);
          if (!entries.length || new Set(entries.map(e => e.verification_id)).size !== entries.length || entries.some(e => e.candidate_id !== candidate || this.seen.has(text(e.verification_id)))) throw new ClientError('PROTOCOL_ERROR', '报告目录重复或不完整');
          const next = text(page.next_cursor) || undefined;
          if (next && this.cursors.has(next)) throw new ClientError('PROTOCOL_ERROR', '报告目录游标重复');
          if (next) this.cursors.add(next);
          entries.forEach(e => this.seen.add(text(e.verification_id)));
          collected.push(...entries); this.cursor = next;
          if (collected.length > this.count || collected.length > 10000) throw new ClientError('OUTPUT_LIMIT', '报告目录超出固定集合或 10,000 项限制');
        } while (this.cursor);
        if (collected.length !== this.count) throw new ClientError('PROTOCOL_ERROR', '报告目录数量不完整');
        this.entries = collected.sort((a, b) => text(b.created_at).localeCompare(text(a.created_at)) || text(b.verification_id).localeCompare(text(a.verification_id)));
        this.started = true;
      }
      const entry = this.entries[0];
      const report = await this.reader.query('verification', [text(entry.verification_id)], signal);
      if (report.verification_id !== entry.verification_id || report.candidate_id !== candidate || record(report.report).candidate_id !== candidate || record(report.report).result_tree_oid !== record(this.trace.artifact).result_tree_oid || report.created_at !== entry.created_at || report.overall_verdict !== entry.overall_verdict || report.mode !== entry.mode || JSON.stringify(report.attribution) !== JSON.stringify(entry.attribution))
        throw new ClientError('PROTOCOL_ERROR', '报告正文与固定目录或 Candidate 工件不匹配');
      if (signal?.aborted) return;
      const bytes = Buffer.byteLength(JSON.stringify(report));
      if (this.reportBytes + bytes > 16 * 1024 * 1024) throw new ClientError('OUTPUT_LIMIT', '当前会话已加载报告正文超过 16 MiB；请用核心 CLI 阅读更多报告，或刷新以释放正文');
      this.reportBytes += bytes;
      this.reports.push(report); this.entries.shift();
    } catch (error) {
      if (!this.started) { this.cursor = undefined; this.cursors.clear(); this.seen.clear(); }
      throw error;
    } finally { this.loading = false; }
  }
}
