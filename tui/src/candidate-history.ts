import { ClientError, type Data } from './protocol.js';
import type { Reader } from './client.js';

const obj = (input: unknown): Data => input && typeof input === 'object' && !Array.isArray(input) ? input as Data : {};
const objects = (input: unknown): Data[] => Array.isArray(input) ? input.map(obj) : [];
const value = (input: unknown): string => input === undefined || input === null || input === '' ? '未知 / 未观察' : typeof input === 'object' ? JSON.stringify(input) : String(input);
const status = (input: unknown): string => { const object = obj(input); return value(object.status ?? object.phase ?? object.state ?? (typeof input === 'object' ? undefined : input)); };

export async function loadCandidateArchiveStatus(reader: Reader, candidateId: string, gitArtifact: unknown, signal?: AbortSignal): Promise<Data> {
  const data = await reader.query('archiveStatus', [candidateId], signal);
  if (data.candidate_id !== candidateId) throw new ClientError('PROTOCOL_ERROR', '归档观察的候选身份不匹配');
  const expected = obj(obj(gitArtifact).binding);
  for (const projection of [data.artifact, data.local_availability, data.remote_observation]) {
    if (projection === undefined) continue;
    const binding = obj(obj(projection).binding);
    for (const key of ['repository_id', 'canonical_remote', 'archive_ref', 'source_commit', 'ordered_parents', 'result_tree', 'base_commit', 'retained_commits']) {
      if (JSON.stringify(binding[key]) !== JSON.stringify(expected[key])) throw new ClientError('PROTOCOL_ERROR', '归档观察与固定候选绑定不匹配');
    }
  }
  return data;
}

/** Render public CLI facts; historical success never implies current remote availability. */
export function candidateHistoryLines(candidate: Data, trace: Data = {}): string[] {
  const artifact = obj(trace.artifact), git = obj(candidate.git_artifact ?? artifact.git_artifact);
  const binding = obj(git.binding), receipt = obj(git.receipt), current = obj(trace.archive_status ?? candidate.archive_status);
  const observation = obj(current.remote_observation), local = obj(current.local_availability);
  const basis = obj(trace.comparison_basis ?? candidate.comparison_basis), lineage = obj(candidate.lineage ?? trace.lineage);
  const operations = objects(candidate.archive_history ?? trace.archive_history ?? current.archive_history);
  const adoptions = objects(candidate.adoption ?? trace.adoption);
  const present = Object.keys(git).length || Object.keys(current).length || Object.keys(basis).length || Object.keys(lineage).length || operations.length || adoptions.length;
  if (!present) return candidate.refines_candidate_id ? [`修订前身：${value(candidate.refines_candidate_id)}`] : [];
  const lines = ['## 代码归档与历史',
    `本机代码可用性：${status(local)} · 观察时间：${value(local.observed_at)}`,
    `历史归档回执：${status(receipt)} · 确认时间：${value(receipt.observed_at)}`,
    `当前远程观察：${status(observation)} · 观察时间：${value(observation.observed_at)}`,
    `代码完整性（本机）：${value(local.integrity)}`,
    ...(observation.reason ? [`远程观察原因：${value(observation.reason)}`] : []),
    ...(local.reason ? [`本机观察原因：${value(local.reason)}`] : []),
    '历史归档成功不代表当前远程可读，也不代表验证通过或已采用。'];
  if (Object.keys(binding).length) lines.push(`固定来源 C：${value(binding.source_commit)}`, `固定逻辑起点：${value(binding.base_commit)}`, `归档引用：${value(binding.archive_ref)}`, `归档仓库：${value(binding.canonical_remote)}`);
  if (Object.keys(basis).length) lines.push('## 固定比较参照', `左端点：${value(basis.left_commit)}`, `右端点：${value(basis.right_commit)}`, `右侧代码树：${value(basis.right_tree)}`, `比较用途：${value(basis.purpose)}`, `生成规则：${value(basis.generator_version)}`, `差异可用状态：${value(basis.diff_state ?? artifact.patch_state)}`);
  const candidateId = candidate.candidate_id;
  if (candidateId) lines.push('## 固定历史差异查询', `candidate diff ${value(candidateId)} --view candidate|original|upstream|evolution|cumulative`, 'landing 视图另传 --landing-record ID；target 视图另传 --target-commit OID --observation-time ISO。新时点目标比较不代表候选已整合该目标或已准备交付。');
  const predecessor = lineage.refines_candidate_id ?? candidate.refines_candidate_id;
  lines.push(`原始开发 B：${value(lineage.initial_base_commit)}`, `修订前身：${predecessor ? value(predecessor) : '未记录'}`, `修订后继：${Array.isArray(lineage.successor_candidate_ids) ? lineage.successor_candidate_ids.map(value).join('、') || '无' : '未加载'}`);
  if (lineage.successors_omitted === true) lines.push('后继未全部列出，请通过 candidate lineage 查询完整范围。');
  for (const record of adoptions) {
    const landing = obj(record.landing), adopted = obj(landing.adoption), decision = obj(landing.decision);
    const predecessor = obj(landing.target_predecessor), landed = obj(landing.actual_landing);
    lines.push('## 实际采用（与归档、验证分别判断）', `采用记录：${value(record.id)} · 时间：${value(record.created_at)}`, `落地判断：${value(decision.outcome)}`, `候选来源 C：${value(adopted.source_commit ?? binding.source_commit)}`, `实际落地 L：${value(adopted.landed_commit ?? obj(landing.actual_landing).oid)}`, `合入方式：${value(adopted.method)}`);
    lines.push(`实际目标更新前驱 P：${predecessor.state === 'confirmed' ? value(obj(predecessor.commit).oid) : '未知 / 未确认'}`, `前驱证据：${value(predecessor.state ?? 'unknown')} · 来源：${value(predecessor.source)}`,
      `Git 首父（L.parents[0]）：${value(Array.isArray(landed.parents) ? landed.parents[0] : undefined)}`,
      ...(adopted.target_predecessor ? [`采用声明的前驱：${value(adopted.target_predecessor)}`] : []),
      ...(predecessor.reason ? [`前驱证据原因：${value(predecessor.reason)}`] : []),
      '实际采用、P 的证据和落地归档分别判断；FF 多提交的 P 可能不同于 Git 首父。旧记录缺少 P 时不推断。');
  }
  if (!adoptions.length) lines.push('实际采用：未记录 / 未加载；归档不证明合入或上线。');
  for (const operation of operations) lines.push(`归档操作：${value(operation.operation_id)} · ${status(operation)} · ${value(operation.purpose)}`, `操作更新：${value(operation.updated_at)} · 原因：${value(operation.reason)}`);
  if (operations.some(operation => operation.phase === 'prepared' || operation.phase === 'unknown' || operation.phase === 'verified')) lines.push('未完成操作需要检查原 operation ID 并恢复，不应重新提交或覆盖引用。');
  return lines;
}
