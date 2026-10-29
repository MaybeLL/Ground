import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { assertContract } from "./schema-fixture.js";
import { runCLI } from "../src/cli.js";
import { git } from "../src/env-git.js";
import { docker } from "../src/env-docker.js";
import { archiveCLITransport } from "./archive-cli-fixture.js";

test("a compiled Go project preserves tested source through Candidate reclamation and refinement", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 360_000,
}, async t => {
  const routeIDs: string[] = [];
  t.after(() => {
    for (const route of routeIDs) for (const id of docker(["ps", "-aq", "--filter", `label=grounds.code-route=${route}`]).split("\n").filter(Boolean))
      docker(["rm", "-f", id]);
  });
  const x = await executionFixture(t, undefined, true, false,
    fileURLToPath(new URL("./fixtures/workspace-go-orders/", import.meta.url)));
  routeIDs.push(x.route.route_id);
  const config = join(x.root, "config.json"), startFile = join(x.root, "start.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const who = () => ["--operation-id", actor().operation_id, "--agent-id", "fixture", "--agent-name", "Fixture"];
  const at = async (cwd: string, ...args: string[]) => {
    const lines: string[] = [];
    const code = await runCLI([...args, "--config", config, "--json"], { cwd, stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n")); assertContract("cli-envelope.schema.json", envelope);
    assert.equal(code, 0, JSON.stringify(envelope)); return envelope.data;
  };
  const invoke = (...args: string[]) => at(x.root, ...args);
  // /tmp is deliberately noexec and bounded; Go's compiler scratch space lives in ignored workspace output.
  const buildEnv = `mkdir -p .build/cache .build/tmp .build/modules
export GOCACHE=/workspace/.build/cache GOTMPDIR=/workspace/.build/tmp GOMODCACHE=/workspace/.build/modules
export GOPROXY=off GOSUMDB=off GOTOOLCHAIN=local CGO_ENABLED=0 GOMAXPROCS=2
go version > .build/toolchain.txt`;
  const fixed = "package orders\n\nfunc Total(unit, quantity, discount int) int {\n\treturn unit*quantity - discount\n}\n";
  const execute = async (route: string, script: string) => {
    writeFileSync(startFile, JSON.stringify({ image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, mode: "development", argv: ["sh", "-ec", script] }));
    const run = (await invoke("code-workspace", "execution-start", route, "--file", startFile, ...who())).execution;
    const result = await invoke("code-workspace", "execution-serve", route, run.execution_id);
    assert.deepEqual(result.outcome, { reason: "exited", exit_code: 0 });
    assert.equal(result.execution.state, "stopped");
  };
  await execute(x.route.route_id, `${buildEnv}
if go test -p 1 -count=1 ./... > .build/baseline.log 2>&1; then echo 'buggy baseline unexpectedly passed'; exit 51; fi
test -f /baselines/payments/pricing.go
python3 - <<'PY'
from pathlib import Path
Path('pricing.go').write_text(${JSON.stringify(fixed)})
PY
gofmt -w pricing.go
go test -p 1 -count=1 ./... > .build/test.log 2>&1
go build -p 1 -o .build/order ./cmd/order
.build/order > .build/actual.txt
grounds-git --timeout 120 stage pricing.go
grounds-git --timeout 120 commit -m 'Account for order quantity' --author-name Agent --author-email agent@example.invalid`);
  assert.match(readFileSync(join(x.route.path, ".build/baseline.log"), "utf8"), /Total = 1200; want 2450/);
  assert.match(readFileSync(join(x.route.path, ".build/test.log"), "utf8"), /ok\s+example.invalid\/orders/);
  assert.equal(readFileSync(join(x.route.path, ".build/actual.txt"), "utf8"), "2450\n");
  assert.match(readFileSync(join(x.route.path, ".build/toolchain.txt"), "utf8"), /go version/);
  t.diagnostic(readFileSync(join(x.route.path, ".build/toolchain.txt"), "utf8").trim());
  assert.equal(git(["rev-list", "--count", `${x.firstCommit.slice(5)}..HEAD`], { cwd: x.route.path }), "1");
  assert.equal(git(["status", "--porcelain"], { cwd: x.route.path }), "");
  assert.equal(git(["ls-files", ".build"], { cwd: x.route.path }), "");

  const transport = archiveCLITransport(t, x.root, x.remote, x.ledger.repository.repository_id);
  git(["config", "--unset-all", `url.file://${x.remote}.insteadOf`], { cwd: x.route.path });
  const policy = transport.policy();
  const submit = async (route: { path: string; dev_run_id: string }) => {
    const form = (await at(route.path, "candidate", "template", "--dev-run", route.dev_run_id)).submission;
    form.explanation = "Author-only explanation: compiled order quantity and discount behavior";
    for (const claim of form.claims) {
      claim.explanation = "Implemented and tested in the container";
      for (const criterion of claim.criteria) criterion.explanation = "Checked the synthetic Go project";
    }
    for (const rationale of form.change_rationales) {
      rationale.target_refs = [{ type: "criterion", id: form.claims[0].criteria[0].criterion_id }];
      rationale.rationale = "Fix the selected behavior";
    }
    const file = join(x.root, `${route.dev_run_id}.json`); writeFileSync(file, JSON.stringify(form));
    return at(route.path, "candidate", "submit", "--dev-run", route.dev_run_id, "--expected-version", "1", "--file", file,
      "--archive-policy", policy, ...who());
  };
  const candidate = await submit({ path: x.route.path, dev_run_id: x.route.dev_run_id! });
  const sourceHead = git(["rev-parse", "HEAD"], { cwd: x.route.path });
  const tag = `refs/tags/grounds/candidates/${candidate.candidate_id}`;
  assert.equal(candidate.source.commit, `sha1:${sourceHead}`);
  assert.equal(git(["rev-parse", tag], { gitDir: x.remote }), sourceHead);
  const artifact = (await at(x.route.path, "candidate", "artifact", candidate.candidate_id)).artifact;
  assert.equal(artifact.base_commit, x.firstCommit);
  const blind = (await at(x.route.path, "verification", "context", candidate.candidate_id, "--phase", "blind")).context;
  assertContract("verification-context.schema.json", blind);
  assert.equal(blind.result_tree_oid, candidate.result_tree_oid);
  assert.equal(JSON.stringify(blind).includes("Author-only explanation"), false);
  await invoke("code-workspace", "end", x.instance.instance_id, "--expected-version", "0", "--retention-days", "0", ...who());
  const preview = async () => (await invoke("code-workspace", "cleanup-preview", x.instance.instance_id, "--archive-policy", policy)).plan;
  const blocked = await preview();
  assert.ok(blocked.resources.some((r: any) => r.kind === "development" && r.state === "blocked" && r.reason === "unpreserved_files"), JSON.stringify(blocked));
  // Explicitly discard only this fixture's known reproducible compiler output, after inspecting its results.
  rmSync(join(x.route.path, ".build"), { recursive: true });
  const plan = await preview();
  assert.ok(plan.resources.every((r: any) => r.state === "eligible"), JSON.stringify(plan));
  await invoke("code-workspace", "cleanup", x.instance.instance_id, "--expected-version", String(plan.lifecycle_version),
    "--plan-digest", plan.plan_digest, "--archive-policy", policy, ...who());
  assert.equal(existsSync(x.route.path), false);
  const original = await x.service.instance(x.instance.instance_id);
  assert.equal(original.lifecycle?.state, "code_reclaimed");
  for (const baseline of original.baselines) assert.equal(existsSync(baseline.path), false);
  assert.equal(git(["rev-parse", tag], { gitDir: x.remote }), sourceHead);

  const restored = (await invoke("code-workspace", "restore", original.instance_id, "--candidate", candidate.candidate_id,
    "--context", "original", "--data-root", x.dataRoot, ...who())).instance;
  assert.notEqual(restored.instance_id, original.instance_id);
  await invoke("code-workspace", "prepare", restored.instance_id, "--data-root", x.dataRoot);
  const prepared = await x.service.instance(restored.instance_id);
  assert.deepEqual(prepared.baselines.map(b => [b.alias, b.commit]), original.baselines.map(b => [b.alias, b.commit]));
  const route = (await invoke("code-workspace", "route-prepare", restored.instance_id, "--issue-slug", "discount-floor",
    "--data-root", x.dataRoot, ...who())).route;
  routeIDs.push(route.route_id);
  const bound = (await invoke("code-workspace", "route-bind", "--development-mode", "container", route.route_id, "--data-root", x.dataRoot, ...who())).route;
  assert.equal(git(["rev-parse", "HEAD"], { cwd: route.path }), sourceHead);
  assert.equal(existsSync(join(route.path, ".build")), false, "restore must not depend on old binaries or compiler cache");
  assert.deepEqual((await at(route.path, "candidate", "artifact", candidate.candidate_id)).artifact, artifact);
  assert.deepEqual((await at(route.path, "verification", "context", candidate.candidate_id, "--phase", "blind")).context, blind);
  const context = (await at(route.path, "devrun", "context", "--dev-run", bound.dev_run_id)).context;
  assert.equal(context.refinement.parent_candidate_id, candidate.candidate_id);
  const observation = await at(route.path, "preflight", "observe", "--phase", "start", "--dev-run", bound.dev_run_id, "--refresh", ...who());
  const assessmentFile = join(x.root, "assessment.json");
  writeFileSync(assessmentFile, JSON.stringify({ assessment: "applicable", rationale: "Reviewed restored Go source and frozen context", affected: [] }));
  const assessment = await at(route.path, "preflight", "assess", "--observation", observation.observation_id, "--file", assessmentFile, ...who());
  await at(route.path, "devrun", "admit", "--dev-run", bound.dev_run_id, "--preflight", assessment.assessment_id, "--refresh", ...who());
  const floorTest = '\nfunc TestDiscountFloor(t *testing.T) {\n\tif got := Total(100, 2, 250); got != 0 {\n\t\tt.Fatalf("floor = %d; want 0", got)\n\t}\n}\n';
  const refined = 'package orders\n\nfunc Total(unit, quantity, discount int) int {\n\ttotal := unit*quantity - discount\n\tif total < 0 { return 0 }\n\treturn total\n}\n';
  await execute(route.route_id, `${buildEnv}
go test -p 1 -count=1 ./... > .build/restored.log 2>&1
go build -p 1 -o .build/order ./cmd/order
.build/order > .build/restored-output.txt
python3 - <<'PY'
from pathlib import Path
p = Path('pricing_test.go')
p.write_text(p.read_text() + ${JSON.stringify(floorTest)})
PY
if go test -p 1 -count=1 ./... > .build/refinement-red.log 2>&1; then exit 52; fi
python3 - <<'PY'
from pathlib import Path
Path('pricing.go').write_text(${JSON.stringify(refined)})
PY
gofmt -w pricing.go pricing_test.go
go test -p 1 -count=1 ./... > .build/test.log 2>&1
go build -p 1 -o .build/order ./cmd/order
.build/order > .build/actual.txt
grounds-git --timeout 120 stage pricing.go pricing_test.go
grounds-git --timeout 120 commit -m 'Keep discounted orders nonnegative' --author-name Agent --author-email agent@example.invalid`);
  assert.match(readFileSync(join(route.path, ".build/restored.log"), "utf8"), /ok\s+example.invalid\/orders/);
  assert.equal(readFileSync(join(route.path, ".build/restored-output.txt"), "utf8"), "2450\n");
  assert.match(readFileSync(join(route.path, ".build/refinement-red.log"), "utf8"), /floor = -50; want 0/);
  assert.match(readFileSync(join(route.path, ".build/test.log"), "utf8"), /ok\s+example.invalid\/orders/);
  assert.equal(readFileSync(join(route.path, ".build/actual.txt"), "utf8"), "2450\n");
  const nextCandidate = await submit(bound);
  assert.notEqual(nextCandidate.candidate_id, candidate.candidate_id);
  assert.equal(git(["rev-parse", tag], { gitDir: x.remote }), sourceHead);
  assert.equal(git(["show", `${sourceHead}:pricing_test.go`], { gitDir: x.remote }).includes("TestDiscountFloor"), false);
  assert.ok(git(["show", `${nextCandidate.source.commit.slice(5)}:pricing_test.go`], { gitDir: x.remote }).includes("TestDiscountFloor"));
  assert.equal(git(["rev-parse", `${nextCandidate.source.commit.slice(5)}^`], { gitDir: x.remote }), sourceHead);
  assert.deepEqual(await x.service.instance(original.instance_id), original);
});
