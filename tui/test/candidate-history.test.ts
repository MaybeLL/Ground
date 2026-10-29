import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateHistoryLines } from '../src/candidate-history.js';

test('historical receipt does not imply current availability or integrity', () => {
  const lines = candidateHistoryLines({ git_artifact: { binding: { source_commit: 'C1', base_commit: 'T', archive_ref: 'refs/tags/c1', canonical_remote: 'repo' }, receipt: { status: 'confirmed', observed_at: 'old-time' } } }, { archive_status: { remote_observation: { status: 'missing', observed_at: 'now', reason: 'remote_ref_absent' } } }).join('\n');
  assert.match(lines, /历史归档回执：confirmed · 确认时间：old-time/);
  assert.match(lines, /当前远程观察：missing · 观察时间：now/);
  assert.match(lines, /本机代码可用性：未知 \/ 未观察/);
  assert.match(lines, /代码完整性（本机）：未知 \/ 未观察/);
  assert.match(lines, /remote_ref_absent/);
  assert.match(lines, /不代表验证通过或已采用/);
});

test('fixed endpoints, lineage, adoption and recovery remain distinct', () => {
  const lines = candidateHistoryLines({ refines_candidate_id: 'C0', lineage: { initial_base_commit: 'B', successor_candidate_ids: ['C2', 'CA'] }, adoption: [{ id: 'landing', created_at: 'then', landing: { adoption: { source_commit: 'C1', landed_commit: 'L', method: 'squash' }, decision: { outcome: 'same_content_different_history' } } }], archive_history: [{ operation_id: 'op', phase: 'unknown', purpose: 'candidate_submit' }] }, { comparison_basis: { left_commit: 'T', right_commit: 'C1', right_tree: 'tree', purpose: 'candidate_changes', generator_version: 'v1', diff_state: 'omitted_size' } }).join('\n');
  assert.match(lines, /左端点：T\n右端点：C1/);
  assert.match(lines, /比较用途：candidate_changes\n生成规则：v1/);
  assert.match(lines, /差异可用状态：omitted_size/);
  assert.match(lines, /原始开发 B：B\n修订前身：C0\n修订后继：C2、CA/);
  assert.match(lines, /候选来源 C：C1\n实际落地 L：L/);
  assert.match(lines, /归档操作：op · unknown/);
  assert.match(lines, /原 operation ID 并恢复/);
});

test('legacy data does not invent archival capabilities', () => {
  assert.deepEqual(candidateHistoryLines({}), []);
  assert.deepEqual(candidateHistoryLines({ refines_candidate_id: 'C0' }), ['修订前身：C0']);
});

test('Git Review loads public offline archive status and rejects another Candidate', async () => {
  const { ReviewSession } = await import('../src/review-data.js');
  const calls: unknown[] = [];
  const reader = { async query(method: string, args?: string[]) {
    calls.push([method, args]);
    if (method === 'review') return { trace: { candidate: { candidate_id: 'C1' }, artifact: { git_artifact: { binding: {} } }, verification_set: { count: 0 } } };
    return { candidate_id: 'C1', remote_check: 'not_requested', archive_history: [] };
  } };
  const session = await ReviewSession.open(reader, 'C1');
  assert.deepEqual(calls, [['review', ['C1', '--summary', '--include-diff']], ['archiveStatus', ['C1']]]);
  assert.equal((session.trace.archive_status as Record<string, unknown>).remote_check, 'not_requested');
  await assert.rejects(ReviewSession.open({ async query(method) { return method === 'review' ? { trace: { candidate: { candidate_id: 'C1' }, artifact: { git_artifact: {} } } } : { candidate_id: 'OTHER' }; } }, 'C1'), { code: 'PROTOCOL_ERROR' });
});

test('new versioned archive output retains old envelope checks', async () => {
  const { decode } = await import('../src/protocol.js');
  const envelope = { format: 'patchledger.cli/v1', ok: true, warnings: [], data: { result_type: 'grounds.result.candidate-archive-status/v1', command: 'candidate.archive-status', candidate_id: 'C1', remote_check: 'not_requested', archive_history: [] } };
  assert.equal(decode(JSON.stringify(envelope), 0, 'archiveStatus').candidate_id, 'C1');
  assert.throws(() => decode(JSON.stringify({ ...envelope, data: { ...envelope.data, result_type: 'grounds.result.candidate-archive-status/v2' } }), 0, 'archiveStatus'), { code: 'PROTOCOL_ERROR' });
  assert.throws(() => decode(JSON.stringify(envelope), 1, 'archiveStatus'), { code: 'PROTOCOL_ERROR' });
});

test('archive observations cannot substitute another source under the same Candidate ID', async () => {
  const { loadCandidateArchiveStatus } = await import('../src/candidate-history.js');
  const binding = { repository_id: 'repo', source_commit: 'C1', ordered_parents: ['C0', 'T'] };
  const reader = { async query() { return { candidate_id: 'candidate', remote_observation: { binding: { ...binding, source_commit: 'C2' } } }; } };
  await assert.rejects(loadCandidateArchiveStatus(reader, 'candidate', { binding }), { code: 'PROTOCOL_ERROR' });
});

test('actual fast-forward target predecessor is distinct from the landing Git first parent', () => {
  const lines = candidateHistoryLines({ adoption: [{ id: 'adopted', created_at: 'then', landing: {
    adoption: { source_commit: 'C', landed_commit: 'L', method: 'ff', target_predecessor: 'P' },
    actual_landing: { oid: 'L', parents: ['INTERMEDIATE'], tree_oid: 'tree' },
    target_predecessor: { state: 'confirmed', commit: { oid: 'P', parents: ['B'], tree_oid: 'P-tree' }, source: 'adoption_binding' },
    decision: { outcome: 'same_content_different_history' },
  } }] }).join('\n');
  assert.match(lines, /实际目标更新前驱 P：P/);
  assert.match(lines, /前驱证据：confirmed · 来源：adoption_binding/);
  assert.match(lines, /Git 首父（L.parents\[0\]）：INTERMEDIATE/);
  assert.doesNotMatch(lines, /实际目标更新前驱 P：INTERMEDIATE/);
});

test('legacy or conflicting predecessor evidence never falls back to the landing first parent', () => {
  for (const predecessor of [undefined, { state: 'unknown', reason: 'actual_target_predecessor_unknown' }, { state: 'conflict', reason: 'evidence_conflicts' }]) {
    const lines = candidateHistoryLines({ adoption: [{ id: 'adopted', created_at: 'then', landing: {
      adoption: { source_commit: 'C', landed_commit: 'L', method: 'ff', target_predecessor: 'CLAIMED_P' },
      actual_landing: { oid: 'L', parents: ['INTERMEDIATE'], tree_oid: 'tree' },
      ...(predecessor ? { target_predecessor: predecessor } : {}), decision: { outcome: 'exact_artifact' },
    } }] }).join('\n');
    assert.match(lines, /落地判断：exact_artifact/);
    assert.match(lines, /实际目标更新前驱 P：未知 \/ 未确认/);
    assert.match(lines, /Git 首父（L.parents\[0\]）：INTERMEDIATE/);
    assert.match(lines, /采用声明的前驱：CLAIMED_P/);
    assert.doesNotMatch(lines, /实际目标更新前驱 P：(INTERMEDIATE|CLAIMED_P)/);
  }
});
