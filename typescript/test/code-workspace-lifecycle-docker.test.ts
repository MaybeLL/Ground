import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { archiveCLITransport } from "./archive-cli-fixture.js";
import { assertContract } from "./schema-fixture.js";
import { runCLI } from "../src/cli.js";
import { git } from "../src/env-git.js";
import { docker } from "../src/env-docker.js";
import { RepositoryEnvironments } from "../src/repository-environment.js";

// One continuous public workflow: no private journal changes or internal mocks.
test("container development survives Candidate archival, code and volume reclamation, and fresh-instance refinement", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 240_000,
}, async t => {
  const routeIDs: string[] = [], restoreIDs: string[] = [];
  t.after(() => {
    // Test-owned labels only, including resources created before a failed CLI reply.
    for (const label of [...routeIDs.map(id => `grounds.code-route=${id}`), ...restoreIDs.map(id => `grounds.volume-restore=${id}`)]) {
      const ids = docker(["ps", "-aq", "--no-trunc", "--filter", `label=${label}`]).split("\n").filter(Boolean);
      for (const id of ids) docker(["rm", "-f", id]);
    }
    for (const label of [...routeIDs.map(id => `grounds.code-route=${id}`), ...restoreIDs.map(id => `grounds.volume-restore=${id}`)]) {
      for (const kind of ["network", "volume"]) {
        const ids = docker([kind, "ls", "-q", "--filter", `label=${label}`]).split("\n").filter(Boolean);
        for (const id of ids) docker([kind, "rm", id]);
      }
    }
  });
  const x = await executionFixture(t, undefined, true);
  routeIDs.push(x.route.route_id);
  const config = join(x.root, "config.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const who = () => ["--operation-id", actor().operation_id, "--agent-id", "fixture", "--agent-name", "Fixture"];
  const raw = async (cwd: string, ...args: string[]) => {
    const lines: string[] = [];
    const code = await runCLI([...args, "--config", config, "--json"], { cwd, stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n")); assertContract("cli-envelope.schema.json", envelope);
    return { code, envelope };
  };
  const at = async (cwd: string, ...args: string[]) => {
    const result = await raw(cwd, ...args); assert.equal(result.code, 0, JSON.stringify(result.envelope)); return result.envelope.data;
  };
  const invoke = (...args: string[]) => at(x.root, ...args);
  const environment = await new RepositoryEnvironments(x.ledger.store).save({ ...actor(), environment_id: actor().operation_id,
    repository_id: x.route.repository_id, expected_version: 0, configuration: { name: "Lifecycle fixture",
      image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, postgres: { image: process.env.GROUNDS_CODE_POSTGRES_IMAGE! } } });
  const startFile = join(x.root, "start.json");
  const script = (text: string) => `printf '${text}\\n' > service.txt
grounds-git --timeout 120 stage service.txt
grounds-git --timeout 120 commit -m 'Implement lifecycle fixture' --author-name Agent --author-email agent@example.invalid`;
  writeFileSync(startFile, JSON.stringify({ environment_revision_id: environment.revision_id, mode: "development", argv: ["sh", "-ec", script("container implementation")] }));
  const started = await invoke("code-workspace", "execution-start", x.route.route_id, "--file", startFile, ...who());
  const run = started.execution;
  docker(["exec", run.dependency.container_id, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "task", "-c",
    "CREATE TABLE lifecycle_orders(id int primary key, note text); INSERT INTO lifecycle_orders VALUES (7, 'archived business row')"]);
  const served = await invoke("code-workspace", "execution-serve", x.route.route_id, run.execution_id);
  assert.deepEqual(served.outcome, { reason: "exited", exit_code: 0 });
  assert.equal(git(["show", "HEAD:service.txt"], { cwd: x.route.path }), "container implementation");
  const sourceHead = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  const transport = archiveCLITransport(t, x.root, x.remote, x.ledger.repository.repository_id);
  git(["config", "--unset-all", `url.file://${x.remote}.insteadOf`], { cwd: x.route.path });
  const policy = transport.policy();
  const submit = async (route: { path: string; dev_run_id: string }) => {
    const form = (await at(route.path, "candidate", "template", "--dev-run", route.dev_run_id)).submission;
    form.explanation = "Preserve the exact container-produced commit";
    for (const claim of form.claims) {
      claim.explanation = "Implemented in the container";
      for (const criterion of claim.criteria) criterion.explanation = "Fixture checked fixed context";
    }
    for (const rationale of form.change_rationales) {
      rationale.target_refs = [{ type: "criterion", id: form.claims[0].criteria[0].criterion_id }];
      rationale.rationale = "Implements the fixed issue";
    }
    const file = join(x.root, `${route.dev_run_id}.json`); writeFileSync(file, JSON.stringify(form));
    return at(route.path, "candidate", "submit", "--dev-run", route.dev_run_id, "--expected-version", "1", "--file", file, "--archive-policy", policy, ...who());
  };
  const candidate = await submit({ path: x.route.path, dev_run_id: x.route.dev_run_id! });
  assert.equal(candidate.source.commit, `sha1:${sourceHead}`);
  const tag = `refs/tags/grounds/candidates/${candidate.candidate_id}`;
  assert.equal(git(["rev-parse", tag], { gitDir: x.remote }), sourceHead);
  await invoke("code-workspace", "end", x.instance.instance_id, "--expected-version", "0", "--retention-days", "0", ...who());
  const codePlan = (await invoke("code-workspace", "cleanup-preview", x.instance.instance_id, "--archive-policy", policy)).plan;
  assert.ok(codePlan.resources.every((item: any) => item.state === "eligible"), JSON.stringify(codePlan));
  await invoke("code-workspace", "cleanup", x.instance.instance_id, "--expected-version", String(codePlan.lifecycle_version),
    "--plan-digest", codePlan.plan_digest, "--archive-policy", policy, ...who());
  assert.equal(existsSync(x.route.path), false);
  for (const baseline of (await x.service.instance(x.instance.instance_id)).baselines) assert.equal(existsSync(baseline.path), false);
  assert.equal(docker(["volume", "ls", "-q", "--filter", `name=^${run.dependency.volume_name}$`]), run.dependency.volume_name);
  const resource = (action: string, ...args: string[]) => invoke("code-workspace", action, x.route.route_id, "--execution-id", run.execution_id, ...args);
  await resource("service-volume-retire", ...who());
  const servicePlan = (await resource("service-cleanup-preview")).plan;
  await resource("service-cleanup", "--expected-version", String(servicePlan.lifecycle_version), "--plan-digest", servicePlan.plan_digest, ...who());
  const a = (await resource("service-volume-export", ...who())).archive;
  const checks = join(x.root, "checks.json");
  writeFileSync(checks, JSON.stringify({ checks: [{ id: "orders", database: "task", schema: "public", table: "lifecycle_orders", expected_count: 1 }] }));
  const verifyID = actor().operation_id; restoreIDs.push(verifyID);
  const verified = (await resource("service-volume-restore", "--archive-id", a.operation_id, "--checks-file", checks,
    "--operation-id", verifyID, "--agent-id", "fixture", "--agent-name", "Fixture")).restoration;
  assert.equal(verified.verification.business_checks.status, "passed");
  const b = (await resource("service-volume-export", "--compare-archive-id", a.operation_id, "--verified-restore-id", verifyID, ...who())).archive;
  assert.equal((await resource("service-volume-assess", "--archive-id", b.operation_id)).assessment.evidence_status, "complete");
  const deleted = (await resource("service-volume-delete", "--archive-id", b.operation_id,
    "--expected-version", String(servicePlan.lifecycle_version), ...who())).deletion;
  assert.equal(deleted.volume.state, "deleted");
  assert.equal(docker(["volume", "ls", "-q", "--filter", `name=^${run.dependency.volume_name}$`]), "");
  assert.ok(existsSync(deleted.recheck.path));
  assert.equal(git(["rev-parse", tag], { gitDir: x.remote }), sourceHead);
  const original = await x.service.instance(x.instance.instance_id);
  assert.equal(original.lifecycle?.state, "code_reclaimed");

  const restored = (await invoke("code-workspace", "restore", original.instance_id, "--candidate", candidate.candidate_id,
    "--context", "original", "--data-root", x.dataRoot, ...who())).instance;
  assert.notEqual(restored.instance_id, original.instance_id);
  await invoke("code-workspace", "prepare", restored.instance_id, "--data-root", x.dataRoot);
  const prepared = await x.service.instance(restored.instance_id);
  assert.deepEqual(prepared.baselines.map(item => [item.alias, item.commit]), original.baselines.map(item => [item.alias, item.commit]));
  const nextRoute = (await invoke("code-workspace", "route-prepare", restored.instance_id, "--issue-slug", "refinement", "--data-root", x.dataRoot, ...who())).route;
  routeIDs.push(nextRoute.route_id);
  const bound = (await invoke("code-workspace", "route-bind", "--development-mode", "container", nextRoute.route_id, "--data-root", x.dataRoot, ...who())).route;
  assert.equal(git(["rev-parse", "HEAD"], { cwd: nextRoute.path }), sourceHead);
  assert.equal(readFileSync(join(nextRoute.path, "service.txt"), "utf8"), "container implementation\n");
  const nextStartArgs = ["code-workspace", "execution-start", nextRoute.route_id, "--file", startFile, ...who()];
  const unadmitted = await raw(x.root, ...nextStartArgs);
  assert.notEqual(unadmitted.code, 0, "restoring files must not grant execution admission");
  assert.equal(unadmitted.envelope.error.code, "STATE_CONFLICT");
  const context = await at(nextRoute.path, "devrun", "context", "--dev-run", bound.dev_run_id);
  assert.equal(context.context.refinement.parent_candidate_id, candidate.candidate_id);
  const observation = await at(nextRoute.path, "preflight", "observe", "--phase", "start", "--dev-run", bound.dev_run_id, "--refresh", ...who());
  const assessmentFile = join(x.root, "assessment.json");
  writeFileSync(assessmentFile, JSON.stringify({ assessment: "applicable", rationale: "Reviewed restored Candidate and fixed baselines", affected: [] }));
  const assessment = await at(nextRoute.path, "preflight", "assess", "--observation", observation.observation_id, "--file", assessmentFile, ...who());
  await at(nextRoute.path, "devrun", "admit", "--dev-run", bound.dev_run_id, "--preflight", assessment.assessment_id, "--refresh", ...who());
  writeFileSync(startFile, JSON.stringify({ environment_revision_id: environment.revision_id, mode: "development", argv: ["sh", "-ec", script("refined container implementation")] }));
  const nextRun = (await invoke("code-workspace", "execution-start", nextRoute.route_id, "--file", startFile, ...who())).execution;
  assert.notEqual(nextRun.dependency.volume_name, run.dependency.volume_name);
  assert.equal(docker(["exec", nextRun.dependency.container_id, "psql", "-X", "-U", "postgres", "-d", "task", "-At", "-c",
    "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='lifecycle_orders'"]), "0", "new route must not silently reuse archived database state");
  assert.deepEqual((await invoke("code-workspace", "execution-serve", nextRoute.route_id, nextRun.execution_id)).outcome, { reason: "exited", exit_code: 0 });
  const refined = await submit(bound);
  assert.notEqual(refined.candidate_id, candidate.candidate_id);
  assert.equal(git(["rev-parse", tag], { gitDir: x.remote }), sourceHead);
  assert.equal(git(["show", `${refined.source.commit.slice(5)}:service.txt`], { gitDir: x.remote }), "refined container implementation");
  assert.deepEqual(await x.service.instance(original.instance_id), original);
  assert.ok(existsSync(deleted.recheck.path));
  // The independent verified data copy remains usable after all original code and service resources are gone.
  docker(["start", verified.container_id]);
  for (let i = 0; i < 60; i++) {
    try { docker(["exec", verified.container_id, "pg_isready", "-h", "/tmp", "-U", "postgres"]); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.equal(docker(["exec", verified.container_id, "psql", "-h", "/tmp", "-U", "postgres", "-d", "task", "-At", "-c",
    "SELECT note FROM lifecycle_orders WHERE id=7"]), "archived business row");
  docker(["stop", "--time", "5", verified.container_id]);
});
