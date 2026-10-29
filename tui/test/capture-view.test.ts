import { test } from 'node:test';
import assert from 'node:assert/strict';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import { buildTimeline, renderEvidencePane, renderTimeline, type EvidenceRef, type Loaded } from '../src/capture-timeline.js';
import { completenessSummary, draftStage, explainLimitation, fieldTag, reviewChecklist } from '../src/capture-text.js';
import { renderBanner, renderListPreview, renderPublishPreview, renderQAPane, renderTechnical, rowLabels, summarize, viewOf, fallbackSummary } from '../src/capture-panel.js';
import { wrapBlock } from '../src/capture-lines.js';

const plain = (lines: string[]) => lines.map(stripAnsi);
const ref = (id: string, kind: string): EvidenceRef => ({ id, kind, name: `n-${id}`, digest: `sha256:${id}`, size: 10 });
const message = (role: string, body: string, native_time: string, extra: object = {}) => JSON.stringify({ message: { role, content: [{ type: 'input_text', text: body }], ...extra }, native_time });
const call = (extra: object) => JSON.stringify({ format: 'graphkb.call/v1', call_id: 'c1', started_at: Date.parse('2026-10-15T06:40:30.000Z'), ended_at: Date.parse('2026-10-15T06:40:31.000Z'), exit_code: 0, status: 'completed', ...extra });
const okQuery = call({ actual_output: { items: [{ name: 'desktop fixture concurrency', summary: 'Synthetic fixture concurrency is 10.' }], has_more: false, graph_revision: 'desktop-fixture-v1' }, http_observations: [{ status: 200, elapsed_ms: 34, body: { query: 'desktop fixture concurrency', kind: 'facts' }, response: {} }] });
const failedQuery = call({ call_id: 'c2', started_at: Date.parse('2026-10-15T06:53:15.000Z'), exit_code: 1, status: 'failed', http_observations: [] });
const toolOutput = JSON.stringify({ message: { role: 'tool', output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: JSON.stringify({ exit_code: 1, output: "error: required option '--kind <kind>' not specified\n" }) }] }, native_time: '2026-10-15T06:53:16.000Z' });
const bodies: Record<string, string> = {
  u1: message('user', '该 fixture 最大并发是多少？请只查询一次。', '2026-10-15T06:40:22.000Z'),
  q1: okQuery,
  s2: JSON.stringify({ observation: { format: 'graphkb.call/v1', call_id: 'c2', args: ['search', 'x', '--kind', 'nodes'], started_at: Date.parse('2026-10-15T06:53:15.000Z') } }),
  q2: failedQuery,
  t1: toolOutput,
  k2: JSON.stringify({ call_id: 'c2', reason: 'query_failed', state: 'pending_analysis' }),
  a1: message('assistant', '最大并发是 **10**。', '2026-10-15T06:40:38.000Z', { phase: 'final_answer' }),
  u2: message('user', '我觉得应该是 20，请重新核实。', '2026-10-15T06:53:09.000Z'),
  p1: JSON.stringify({ format: 'graphkb.qa-model-proposal/v1', observation: 'model_extraction_unverified', question_span: '该 fixture 最大并发是多少？', model_question_proposal: '该 fixture 最大并发是多少？' }),
};
const refs = [ref('p1', 'model_proposal'), ref('u2', 'question'), ref('a1', 'answer'), ref('t1', 'tool'), ref('k2', 'clue'), ref('q2', 'query'), ref('s2', 'cli_start'), ref('q1', 'query'), ref('u1', 'question')];
const loadAll = (r: EvidenceRef): Loaded | undefined => bodies[r.id] === undefined ? undefined : { state: 'ok', text: bodies[r.id]! };
const timeline = () => buildTimeline(refs, loadAll);

test('timeline reads as a chronological conversation with roles, queries and failures', () => {
  const entries = timeline(), headings = entries.map(e => e.heading);
  assert.deepEqual(headings, ['用户提问', '✓ 查询成功 · 34ms', '模型回答', '用户追问／纠正', '✗ 查询失败', '✗ 工具输出（失败）', '模型拆题建议']);
  const text = plain(renderTimeline(entries, { width: 80, utc: true })).join('\n');
  assert.match(text, /\[1\] 用户提问\s+06:40:22/);
  assert.match(text, /类型 事实（facts） · 关键词「desktop fixture concurrency」/);
  assert.match(text, /返回 1 条：\n│\s+· desktop fixture concurrency — Synthetic fixture concurrency is 10\./);
  assert.match(text, /知识库版本 desktop-fixture-v1/);
  assert.match(text, /退出码 1/);
  assert.match(text, /没有发出网络请求，也没有返回结果/);
  assert.match(text, /系统线索：查询失败 · 待提取/);
  assert.match(text, /error: required option '--kind <kind>' not specified/);
  assert.match(text, /\*\*10\*\*/, 'user/model text is shown literally, never interpreted as Markdown');
  assert.ok(entries.find(e => e.heading === '✗ 查询失败')!.failed);
  assert.ok(!entries.some(e => e.kind === 'cli_start' || e.kind === 'clue'), 'call start and clue merge into the query they belong to');
});

test('timeline keeps unknown evidence readable and shows loading, error and truncated states', () => {
  const entries = buildTimeline([ref('x', 'weird_kind'), ref('y', 'question'), ref('z', 'answer'), ref('w', 'query')], r => r.id === 'x' ? { state: 'ok', text: 'not json at all' } : r.id === 'y' ? { state: 'error', message: '证据已到期' } : r.id === 'w' ? { state: 'ok', text: '{"format":"unknown","a":1}' } : undefined);
  const text = plain(renderTimeline(entries, { width: 60 })).join('\n');
  assert.match(text, /记录（weird_kind）/); assert.match(text, /not json at all/);
  assert.match(text, /读取失败：证据已到期/); assert.match(text, /正在读取…/);
  assert.match(text, /类型 未记录 · 关键词「未记录」/);
});

test('timeline lines never exceed the width and CJK wraps without losing characters', () => {
  const long = '为什么'.repeat(60) + ' english words that should wrap on spaces ' + '并发上限'.repeat(30);
  const entries = buildTimeline([ref('u', 'question'), ref('q1', 'query')], r => ({ state: 'ok', text: r.id === 'u' ? message('user', long, '2026-10-15T06:40:22.000Z') : okQuery }));
  for (const width of [60, 140]) {
    const lines = plain(renderTimeline(entries, { width, utc: true }));
    assert.ok(lines.every(l => stringWidth(l) <= width), `width ${width}`);
    const body = lines.filter(l => l.startsWith('│ ')).map(l => l.slice(2)).join('').replace(/\s/g, '');
    assert.ok(body.includes('为什么'.repeat(60)) && body.includes('并发上限'.repeat(30)));
  }
  assert.ok(wrapBlock('一二三四五六七八九十', 8).every(l => stringWidth(l) <= 8));
});

test('evidence pane translates completeness and flags concerns instead of printing JSON', () => {
  const material = { completeness: { question: 'complete', query: 'complete', answer: 'complete', feedback: 'complete', attachments: 'unknown', subtasks: 'complete' } };
  const text = plain(renderEvidencePane({ entries: timeline(), materials: [material], width: 100, utc: true })).join('\n');
  assert.match(text, /记录完整度：问题✓完整 · 查询✓完整 · 回答✓完整 · 用户反馈✓完整 · 附件！未知 · 子任务✓完整/);
  assert.match(text, /！ 附件：未知。无法确认题目是否依赖附件/);
  assert.match(text, /其中 1 处失败/);
  assert.ok(!text.includes('"question"') && !text.includes('{'), text);
  assert.deepEqual(completenessSummary({ question: 'complete', brand_new: 'weird' }).segments.map(s => `${s.name}:${s.label}:${s.ok}`), ['问题:完整:true', 'brand_new:weird:false']);
  const pending = plain(renderEvidencePane({ entries: buildTimeline(refs, () => undefined), materials: [], width: 60 })).join('\n');
  assert.match(pending, /正在读取现场记录… 已完成 0\/9/);
});

test('limitation codes become plain Chinese, free text stays and unknown codes fall back safely', () => {
  assert.match(explainLimitation('model_extraction_unverified').text, /还没有人核实/);
  assert.match(explainLimitation('private_scoring_requires_human_review').text, /必须由人审核/);
  assert.match(explainLimitation('hidden_reasoning_excluded').text, /隐藏推理/);
  assert.match(explainLimitation('historical_state_requires_reproducible_public_conditions').text, /公开、固定、可重现/);
  assert.equal(explainLimitation('附件观察不完整，但可见问题没有明确依赖附件。').text, '附件观察不完整，但可见问题没有明确依赖附件。');
  const unknown = explainLimitation('some_future_flag');
  assert.equal(unknown.known, false); assert.match(unknown.text, /暂无中文说明.*some_future_flag/);
});

const goodMaterials = [{ completeness: { question: 'complete', query: 'partial', answer: 'complete' }, evidence: [{ kind: 'question', size: 9 }, { kind: 'query', size: 9 }, { kind: 'answer', size: 9 }] }];
const qa = { name: '合成 fixture 最大并发', question: '该 fixture 最大并发是多少？', instructions: '依次查询并简短回答。', rubric: '依据固定来源回答。', reference_answer: '最大并发为 10。', required_points: ['给出数值'], forbidden_claims: ['只凭用户纠正认定为 20'], references: [] };
const pendingReview = { status: 'pending', independent_text: false, authority: '', attachments_resolved: false, knowledge: 'unknown' };
const view = (review: object = pendingReview, verified: string[] = []) => viewOf({
  draft: { id: '01a13e5a-23ce-7e60-bbdb-eef1a56cbeab', version: 1, state: 'active', review },
  qa, verified_fields: verified,
  provenance: { name: 'model_suggestion', question: 'model_suggestion', instructions: 'model_suggestion', rubric: 'model_suggestion', reference_answer: 'model_suggestion', required_points: 'human', forbidden_claims: 'model_suggestion', references: 'missing' },
  materials: [{ project: { id: 'desktop-synthetic', first_captured_at: '2026-10-15T06:40:30.779Z', expires_at: '2026-10-22T06:40:30.779Z' }, limitations: ['model_extraction_unverified', '来源为本地合成服务。'], completeness: { question: 'complete', query: 'complete', answer: 'complete' }, evidence: [{ kind: 'question', size: 5 }, { kind: 'question', size: 5 }, { kind: 'query', size: 5 }, { kind: 'answer', size: 5 }] }],
});

test('right pane separates what the examinee sees from private scoring and tags every field', () => {
  const lines = plain(renderQAPane(view(pendingReview, ['rubric']), 70)), text = lines.join('\n');
  const at = (s: string) => lines.findIndex(l => l.includes(s));
  assert.ok(at('一、被测者能看到（公开）') < at('公开题目 [') && at('公开题目 [') < at('二、只有评分时可见') && at('二、只有评分时可见') < at('私有评分标准（Rubric） [') && at('私有评分标准（Rubric） [') < at('三、依据、来源与限制'));
  assert.match(text, /公开题目 \[模型建议，待核对\]\n  该 fixture 最大并发是多少？/);
  assert.match(text, /私有评分标准（Rubric） \[已人工确认\]/);
  assert.match(text, /必答要点 \[人工填写\]\n  1\. 给出数值/);
  assert.match(text, /私有依据 \[暂无\]/);
  assert.match(text, /权威依据 \[待补\]/); assert.match(text, /知识类型\s+未判定/);
  assert.match(text, /发布前检查 · 还差 5 项/); assert.match(text, /\[ \] 题面脱离原对话也能独立看懂\n\s+→ 按 :/);
  assert.match(text, /题面、答案和评分条件是模型从对话里提取的/); assert.ok(!text.includes('model_extraction_unverified'));
  assert.match(plain(renderQAPane(view(), 200)).join('\n'), /项目 desktop-synthetic · 采集 2026-10-1\d \d\d:\d\d · 自动材料 2026-10-2\d \d\d:\d\d 到期/);
  assert.ok(lines.every(l => stringWidth(l) <= 70));
});

test('review status, remaining items and the next step are explicit for every state', () => {
  const stage = (draft: object, hasQA = true) => draftStage(draft, qa, hasQA);
  assert.deepEqual([stage({ state: 'active', review: pendingReview }).badge, stage({ state: 'active', review: pendingReview }).remaining], ['待审核·缺5项', 5]);
  assert.match(stage({ state: 'active', review: pendingReview }).next, /题面脱离原对话也能独立看懂.*独立文本题面/);
  const ready = { status: 'reviewed', independent_text: true, authority: '权威文档 A', attachments_resolved: true, knowledge: 'stable' };
  const readyStage = draftStage({ state: 'active', review: ready }, qa, true, goodMaterials);
  assert.equal(readyStage.badge, '可预览'); assert.match(readyStage.next, /选择题集与模板并预览发布.*还会复核证据和残留的待补文字/);
  assert.equal(stage({ state: 'active', review: ready }).badge, '可预览', 'without material info the gate list cannot see evidence, so it stays optimistic only for display');
  const historical = reviewChecklist({ ...ready, knowledge: 'historical' }, qa);
  assert.equal(historical.find(i => i.key === 'conditions')!.done, false);
  assert.equal(stage({ state: 'replaced', review: ready }).badge, '已被替代');
  assert.match(stage({ state: 'boundary_pending', review: ready }).next, /关联已有题目.*独立新题/);
  assert.equal(stage({ state: 'active', review: ready, journal: { state: 'published' } }).badge, '已发布');
  assert.match(stage({ state: 'active', review: ready, journal: { state: 'partial' } }).next, /核查并恢复原发布/);
  assert.equal(stage({ state: 'active', review: { ...ready, status: 'ignored' } }).badge, '已忽略');
  assert.deepEqual([fieldTag('question', { question: '' }, {}, []).text, fieldTag('references', { references: [] }, {}, []).text], ['待补', '暂无']);
  const banner = plain(renderBanner(view(), 140)).join('\n');
  assert.match(banner, /审核状态：待审核 · 还差 5 项才能预览发布 · 已人工确认 0\/7 个已填字段/); assert.match(banner, /下一步：题面脱离原对话也能独立看懂。按 : →「审核条件与权威依据」/);
  const compact = plain(renderBanner(view(), 59));
  assert.deepEqual(compact, ['审核：待审核 · 还差 5 项才能预览发布', '下一步：题面脱离原对话也能独立看懂'], 'narrow banner keeps two short lines; the how-to stays in the right pane');
});

test('draft list rows tell drafts apart by question title, status and what is missing', () => {
  const a = summarize(view()), b = summarize(viewOf({ ...{ draft: { id: '01a13e5a-252b-779c-8953-4f229df0f1e1', state: 'active', review: pendingReview }, qa: { ...qa, name: '合成 fixture 图版本', question: '当前 graph_revision 是什么？' }, materials: goodMaterials, provenance: {}, verified_fields: [] } }));
  const labels = rowLabels([a, b]);
  assert.deepEqual(labels, ['[待审核·缺5项] 合成 fixture 最大并发', '[待审核·缺5项] 合成 fixture 图版本']);
  assert.ok(labels.every(l => !l.includes('gra…') && !l.includes('01a13e5a')));
  assert.deepEqual(rowLabels([a, { ...a, id: '01a13e5a-9999-0000-0000-00000000abcd' }]).map(l => l.endsWith('#beab') || l.endsWith('#abcd')), [true, true], 'same title gets a distinguishing suffix');
  const preview = plain(renderListPreview([a, b], a.id, 50)).join('\n');
  assert.match(preview, /共 2 份草稿，2 份还需要你处理/); assert.match(preview, /题面：该 fixture 最大并发是多少？/);
  assert.match(preview, /现场：用户消息 2 · 查询 1 · 模型回答 1/); assert.match(preview, /下一步：/);
  assert.match(plain(renderListPreview([a], undefined, 50)).join('\n'), /按 ↑↓ 选择/);
  const fallback = fallbackSummary({ id: '01a13e5a-23ce-7e60-bbdb-eef1a56cbeab', state: 'active', review: { status: 'pending' } });
  assert.match(rowLabels([fallback])[0]!, /未读取题名 · 01a13e5a/);
});

test('publish preview lists what will be written in plain language and keeps the full JSON behind it', () => {
  const preview = { format: 'grounds.qa-draft-preview/v1', digest: 'sha256:' + 'a'.repeat(64), database_id: 'db-1', draft_id: 'd', qa, review: { status: 'reviewed', knowledge: 'stable', authority: '权威文档 A' }, public_input: { question: qa.question, instructions: qa.instructions }, suite: { id: 's1', version: 3, data: { name: '标注题集' } }, template: { id: 'g1', version: 2, data: { name: '质量模板' } }, target: { member: { mode: 'add' } }, source_package: { digest: 'sha256:' + 'b'.repeat(64), evidence: [{}, {}, {}] }, limitations: ['model_extraction_unverified'] };
  for (const width of [60, 100]) {
    const lines = plain(renderPublishPreview(preview, width)), text = lines.join('\n');
    assert.ok(lines.every(l => stringWidth(l) <= width), `width ${width}`);
    assert.match(text, /还没有写入任何东西/); assert.match(text, /账本 db-1/);
    assert.match(text, /1\. 固定来源包：保存 3 条现场证据/); assert.match(text, /2\. QA 题目「合成 fixture 最大并发」/); assert.match(text, /3\. 评分实例：基于模板「质量模板」v2/); assert.match(text, /4\. 题集「标注题集」v3：新增一个成员/);
    assert.ok(text.indexOf('被测者会看到') < text.indexOf('只有评分时可见'));
    assert.match(text, /还没有人核实过/); assert.match(text, /技术细节：完整预览 JSON/); assert.match(text, /"format": "grounds\.qa-draft-preview\/v1"/);
  }
});

test('terminal control sequences in captured text, kinds or roles never reach the screen', () => {
  const hostile = '\u001b]0;evil-title\u0007\u001b[2Jred\u0000text';
  const entries = buildTimeline([ref('a', `kind${hostile}`), ref('b', 'question'), ref('c', 'answer')], r => ({ state: 'ok', text: r.id === 'a' ? JSON.stringify({ message: { role: `r${hostile}`, content: [{ text: hostile }] } }) : message(r.id === 'b' ? 'user' : 'assistant', hostile, '2026-10-15T06:40:22.000Z') }));
  const raw = [...renderTimeline(entries, { width: 60 }), ...renderEvidencePane({ entries, materials: [{ completeness: { question: hostile } }], width: 60 }), ...renderQAPane(view(), 60)].join('\n');
  assert.ok(!raw.includes('\u001b]') && !raw.includes('\u0007') && !raw.includes('\u0000') && !raw.includes('\u001b[2J'), JSON.stringify(raw.slice(0, 400)));
  assert.match(stripAnsi(raw), /redtext/);
});

test('wrapping keeps closing punctuation off the start of a line and never exceeds the width', () => {
  const lines = wrapBlock('一二三四五，六七八九十。（括号内容）结束', 10);
  assert.ok(lines.every(l => stringWidth(l) <= 10), JSON.stringify(lines));
  assert.ok(lines.every(l => !/^[，。）]/.test(l)), JSON.stringify(lines));
  assert.equal(lines.join(''), '一二三四五，六七八九十。（括号内容）结束');
  assert.deepEqual(wrapBlock('keep these words together when possible', 20), ['keep these words', 'together when', 'possible'].map(l => l));
});

test('checklist mirrors the real gate: evidence coverage, placeholders and historical instructions', () => {
  const ready = { status: 'reviewed', independent_text: true, authority: '权威文档 A', attachments_resolved: true, knowledge: 'stable' };
  const open = (review: object, q: object = qa, materials?: object[]) => reviewChecklist(review as any, q as any, materials as any).filter(i => !i.done).map(i => i.key);
  assert.deepEqual(open(ready, qa, goodMaterials), []);
  assert.deepEqual(open(ready, qa, [{ completeness: { question: 'complete', query: 'missing', answer: 'complete' }, evidence: goodMaterials[0]!.evidence }]), ['evidence'], 'a query recorded as missing blocks publication');
  assert.deepEqual(open(ready, qa, [{ completeness: goodMaterials[0]!.completeness, evidence: [{ kind: 'question', size: 9 }, { kind: 'query', size: 0 }, { kind: 'answer', size: 9 }] }]), ['evidence'], 'an empty body does not count');
  assert.deepEqual(open(ready, { ...qa, rubric: '待补' }, goodMaterials), ['content'], 'a bare 待补 marker is not content');
  assert.deepEqual(open({ ...ready, authority: 'TBD' }, qa, goodMaterials), ['authority']);
  const historical = { ...ready, knowledge: 'historical', answer_conditions: { accessible: true, preserves_question: true, locator: 'doc://fixed', instructions: '请查阅固定文档' } };
  assert.deepEqual(open(historical, qa, goodMaterials), ['conditions'], 'conditions must also appear in the public instructions');
  assert.deepEqual(open(historical, { ...qa, instructions: `${qa.instructions} 请查阅固定文档` }, goodMaterials), []);
});

test('missing automatic material, omitted records and truncated bodies are called out', () => {
  const pane = plain(renderEvidencePane({ entries: timeline(), materials: [], width: 90, utc: true, missing: ['graphkb:x@r1: expired'], omitted: 3 })).join('\n');
  assert.match(pane, /另有 3 条记录没有预读/); assert.match(pane, /1 份自动材料已到期或读取失败/);
  assert.match(plain(renderTechnical({ ...view(), missing: ['graphkb:x@r1: expired'] }, 80)).join('\n'), /自动材料读取失败或已到期：graphkb:x@r1: expired/);
  const truncated = plain(renderTimeline(buildTimeline([ref('x', 'weird')], () => ({ state: 'ok', text: '{"cut":', truncated: true })), { width: 70 })).join('\n');
  assert.match(truncated, /只读取了开头/);
  const blank = buildTimeline([ref('q', 'query'), ref('s', 'cli_start'), ref('k', 'clue')], r => ({ state: 'ok', text: r.id === 'q' ? call({ call_id: '', actual_output: { items: [] } }) : r.id === 's' ? JSON.stringify({ observation: { args: ['search', 'x'] } }) : JSON.stringify({ reason: 'query_failed', state: 'pending_analysis' }) }));
  assert.equal(blank.length, 3, 'records without a call id are never merged into an unrelated query');
});

test('a conflict-recovery preview says only the suite member is placed again', () => {
  const lines = plain(renderPublishPreview({ database_id: 'db', qa, review: { knowledge: 'stable' }, public_input: { question: qa.question, instructions: qa.instructions }, suite: { id: 's', version: 4, data: { name: '题集' } }, template: { id: 't', version: 1, data: { name: '模板' } }, target: { member: { mode: 'update', id: 'm1' } }, source_package: { digest: 'sha256:' + 'c'.repeat(64) }, conflict: { previous_target: {} } }, 80)).join('\n');
  assert.match(lines, /冲突恢复：只重新放置题集成员/); assert.match(lines, /沿用上次已经创建的固定来源包、QA 题目和评分实例/); assert.match(lines, /更新成员 m1/);
  assert.ok(!lines.includes('保存 0 条现场证据') && !lines.includes('确认后会依次创建'));
});
