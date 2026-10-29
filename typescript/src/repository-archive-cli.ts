import { readArchiveProtectionPolicy, type ArchivePolicyCheck } from "./candidate-git-archive.js";
import { resolve } from "node:path";
import type { ParsedArgs } from "./cli.js";
import type { Attribution } from "./domain.js";
import { DomainError, validation } from "./errors.js";
import { isUUIDv7 } from "./identity.js";
import { archiveConfigurationGuide, RepositoryArchiveAccess, type ArchiveAccessReport } from "./repository-archive-access.js";
import type { Store } from "./store-types.js";

export const repositoryArchiveCommands = {
  "archive-show": { options: ["config", "repository"], description: "读取所选仓库的共享GitLab项目绑定；离线状态不证明当前授权，使用 archive-check 复查" },
  "archive-check": { options: ["config", "repository", "instance"], description: "实时只读检查GitLab项目、两个完整归档命名空间和当前用户权限；重复 --repository 可汇总明确选定项目" },
  "archive-guide": { options: ["config", "repository", "instance"], description: "实时检查并预览逐项目管理员配置建议；保留严格规则，不写GitLab ACL或成员角色；重复 --repository 可批量引导" },
  "archive-template": { options: ["config", "repository", "instance"], description: "输出可复用的双命名空间默认模板及所选项目检查/建议；不含认证或机器路径，不执行预览中的请求" },
  "archive-bind": { options: ["config", "repository", "instance", "expected-version", "operation-id", "agent-id", "agent-name"], description: "实时发现并显式保存一个仓库的GitLab实例/项目绑定；初次 --expected-version 0，绑定不缓存授权或自动修改ACL" },
} as const;

export async function executeRepositoryArchive(input: { action: keyof typeof repositoryArchiveCommands; args: ParsedArgs; store: Store; attribution: () => Attribution; operationID: () => string }) {
  const raw = input.args.values.repository;
  const ids = raw === undefined ? [] : Array.isArray(raw) ? raw : [String(raw)];
  if (!ids.length || ids.length > 50 || ids.some(id => !isUUIDv7(id)) || new Set(ids).size !== ids.length) throw validation("repository", "explicit unique --repository UUIDv7 required (maximum 50)");
  const instance = input.args.values.instance === undefined ? undefined : String(input.args.values.instance);
  const access = new RepositoryArchiveAccess(input.store);
  const base = { result_type: "grounds.result.repository-archive-access/v1", command: `repository.${input.action}` };
  if (input.action === "archive-show" || input.action === "archive-bind") {
    if (ids.length !== 1) throw validation("repository", "this operation requires exactly one repository");
    if (input.action === "archive-show") return { ...base, status: await access.status(ids[0]!) };
    const expected = String(input.args.values["expected-version"] ?? "");
    if (!/^(0|[1-9][0-9]*)$/.test(expected)) throw validation("expected-version", "nonnegative binding version required");
    return { ...base, ...await access.bind({ repository_id: ids[0]!, ...(instance ? { instance } : {}), expected_version: Number(expected), operation_id: input.operationID(), attribution: input.attribution() }) };
  }
  const projects: ({ repository_id: string; report: ArchiveAccessReport; guide?: ReturnType<typeof archiveConfigurationGuide> } | { repository_id: string; error: { code: string; reason: string } })[] = [];
  for (const id of ids) {
    try {
      const report = await access.check(id, instance);
      projects.push({ repository_id: id, report, ...(input.action !== "archive-check" ? { guide: archiveConfigurationGuide(report) } : {}) });
    } catch (error) {
      // Keep partial batch results and don't expose transport or credential errors.
      projects.push({ repository_id: id, error: { code: error instanceof DomainError ? error.code : "STATE_CONFLICT", reason: "所选仓库无法检查；核对注册仓库、实例和项目范围后单独复查。" } });
    }
  }
  return { ...base, projects, summary: { selected: ids.length, ready: projects.filter(project => "report" in project && project.report.state === "ready").length, requires_attention: projects.filter(project => !("report" in project) || project.report.state !== "ready").length },
    meaning: "接入就绪只证明本次项目配置及调用者权限；某个工件归档、Verification、实际采用和软件发行分别判断。" };
}

/** The explicit legacy source always takes precedence. There is no automatic
 * fallback from failed live authentication to a saved receipt. */
export function archivePolicyFor(store: Store, cwd: string, file?: string): ArchivePolicyCheck {
  const selected = file || process.env.GROUNDS_ARCHIVE_POLICY;
  return selected ? (binding, at) => readArchiveProtectionPolicy(resolve(cwd, selected), binding, at) : new RepositoryArchiveAccess(store).policy();
}
