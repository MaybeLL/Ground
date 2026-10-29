import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionLines, deliveryStatus } from '../src/completion-view.js';
import { issueDetailLines, requirementLines } from '../src/requirement-view.js';
test('completed delivery displays no pending action and retains verification risk', () => {
 const board = { status: 'completed', next_action: null, candidate_count: 1, selection: { current_verification: { standing: 'rejected' } }, completion: { state: 'completed', record: { attribution: { display_name: 'Recorder' }, completion: { completed_at: '2026-01-01T00:00:00.000Z', target_branch: 'refs/heads/dev-v1', landed_commit: 'sha1:abcdef', adoption_evidence: { reference: 'https://example.test/mr', description: 'Confirmed' }, release: { status: 'released', version: '0.20.18', channel: 'latest', evidence: { reference: 'https://example.test/npm' } } } } } };
 const lines = completionLines(board).join('\n');
 for (const expected of ['已完成', '无交付待办', 'rejected', '未访问或核验', '0.20.18', 'latest', 'completion reopen', '--issue-version']) assert.ok(lines.includes(expected), expected);
 assert.doesNotMatch(lines, /准备交付|待开发/);
 assert.match(issueDetailLines({ issue: { id: 'issue', version: 1 }, board }, 104).join('\n'), /已完成/);
 assert.match(requirementLines({ summary: 'Need', aggregates: { completion_status: 'no_issues' } }, 104).join('\n'), /尚无实施 Issue/);
 assert.equal(deliveryStatus('incomplete'), '未完成');
});
test('reopened completion retains reason and previous delivery facts', () => {
 const text = completionLines({ status: 'candidate_selected', completion: { state: 'reopened', record: { reason: 'Release withdrawn' } } }).join('\n');
 assert.match(text, /准备交付/); assert.match(text, /Release withdrawn/); assert.doesNotMatch(text, /无交付待办/);
});
