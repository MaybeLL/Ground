import type { DevelopmentModeSelection } from "../src/development-mode.js";
import type { TestContext } from "node:test";
import { join } from "node:path";
import { CodeWorkspaceRoutes } from "../src/code-workspace-route.js";
import { PreflightService } from "../src/preflight.js";
import { hostIdentity } from "../src/runtime-files.js";
import { newUUIDv7 } from "../src/identity.js";
import { git } from "../src/env-git.js";
import { codeWorkspaceFixture } from "./code-workspace-fixture.js";
import { reviseTargetIssue } from "./preflight-fixture.js";
import { testAgent } from "./fixture.js";
import type { SQLStore } from "../src/sql-store.js";
export const actor = () => ({ operation_id: newUUIDv7(), attribution: testAgent });
export async function executionFixture(t: TestContext, dataRoot?: string, related = false, relatedGitlink = false, seedDirectory?: string, store?: SQLStore, executionMode?: DevelopmentModeSelection) {
  const x = await codeWorkspaceFixture(t, seedDirectory, store);
  if (dataRoot) x.dataRoot = dataRoot;
  let configurationVersion = 1;
  let relatedCommit: string | undefined;
  if (related) {
    git(["checkout", "-b", "related"], { cwd: x.writer });
    if (relatedGitlink) git(["update-index", "--add", "--cacheinfo", `160000,${x.firstCommit.split(":")[1]},nested`], { cwd: x.writer });
    relatedCommit = x.publish("related service\n");
    git(["checkout", "main"], { cwd: x.writer });
    const other = await x.ledger.module.registerRepository({ ...actor(), canonical_remote: "ssh://git@example.test/team/payments" });
    const configuration = (await x.service.configuration(x.configurationId)).configuration;
    await x.service.saveConfiguration({ configuration_id: x.configurationId, expected_version: 1, attribution: testAgent,
      configuration: { ...configuration, repositories: [...configuration.repositories,
        { repository_id: other.result.repository_id, alias: "payments", revision: { branch: "related" } }] } });
    configurationVersion = 2;
  }
  const canonical = "ssh://git@example.test/team/repo";
  git(["remote", "set-url", "origin", canonical], { cwd: x.writer });
  git(["config", `url.file://${x.remote}.insteadOf`, canonical], { cwd: x.writer });
  await reviseTargetIssue(x.ledger.module, x.ledger.store, x.writer, {
    ...actor(), issue_id: x.ledger.issue.issue_id, expected_predecessor_id: x.ledger.issue.issue_revision_id,
    requirement_revision_id: x.ledger.requirement.requirement_revision_id, requirement_revision_explicit: true,
    baseline: { git_oid: x.firstCommit, reachability: "remote_tracking_reachable" },
    input: { format: 1, summary: "Workspace target", target_branch: { remote: "origin", ref: "refs/heads/main" },
      goals: [{ statement: "Implement the issue", criteria: ["Preserve the fixed context"] }] },
  });
  const hostId = hostIdentity(join(x.dataRoot, "runtime"));
  const instance = await x.service.createInstance({ ...actor(), configuration_id: x.configurationId, configuration_version: configurationVersion,
    issue_id: x.ledger.issue.issue_id, issue_version: 2, host_id: hostId });
  await x.service.prepareInstance({ instance_id: instance.instance_id, host_id: hostId, data_root: x.dataRoot });
  const cache = join(x.dataRoot, "cache", "repos", instance.target_repository_id);
  git(["config", "remote.origin.url", canonical], { gitDir: cache });
  git(["config", `url.file://${x.remote}.insteadOf`, canonical], { gitDir: cache });
  const routes = new CodeWorkspaceRoutes(x.ledger.store);
  const route = await routes.prepare({ ...actor(), instance_id: instance.instance_id, host_id: hostId,
    data_root: x.dataRoot, issue_slug: "target" });
  const request = { ...actor(), route_id: route.route_id, host_id: hostId, data_root: x.dataRoot };
  const bound = await routes.bindDevRun({ ...request, ...(executionMode ? { execution_mode: executionMode } : {}) });
  const preflight = new PreflightService(x.ledger.store, route.path);
  const admit = async () => {
    const observed = await preflight.observe({ ...actor(), phase: "start", dev_run_id: bound.dev_run_id!, refresh: true });
    const assessment = await preflight.assess({ ...actor(), observation_id: observed.id,
      file: { assessment: "applicable", rationale: "Reviewed the fixed route", affected: [] } });
    await preflight.admit({ ...actor(), dev_run_id: bound.dev_run_id!, assessment_id: assessment.id, refresh: true });
  };
  await admit();
  return { ...x, relatedCommit, hostId, instance, routes, route: bound, request, preflight, admit };
}
