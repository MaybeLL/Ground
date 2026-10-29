import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { executionFixture, actor } from "./code-route-execution-fixture.js";
import { RepositoryEnvironments } from "../src/repository-environment.js";
import { CodeRouteExecutions } from "../src/code-route-execution.js";
import { DockerRouteRuntime } from "../src/code-route-runtime.js";
import { DockerRouteEngine } from "../src/code-route-docker.js";
import { CodeWorkspaceCleanup } from "../src/code-workspace-cleanup.js";
import { CodeRouteServiceCleanup } from "../src/code-route-service-cleanup.js";
import { docker } from "../src/env-docker.js";
import { runCLI } from "../src/cli.js";
import { assertContract } from "./schema-fixture.js";

test("retained PostgreSQL volume exports through CLI, restores independently, previews retained volumes, and rejects corrupt replay", {
  skip: process.env.GROUNDS_CODE_DOCKER_TEST !== "1", timeout: 240_000,
}, async t => {
  const containers: string[] = [], volumes: string[] = [], networks: string[] = [];
  const exportID = actor().operation_id, restoreID = actor().operation_id, uncertainRestoreID = actor().operation_id, failedProbeID = actor().operation_id, mismatchID = actor().operation_id, uncertainVolumeID = actor().operation_id;
  const compareID = actor().operation_id, changedExportID = actor().operation_id, badCompareID = actor().operation_id, changedRestoreID = actor().operation_id;
  const restoredExportID = actor().operation_id, secondRestoreID = actor().operation_id, guardExportID = actor().operation_id, restoredCompareID = actor().operation_id;
  const proofID = actor().operation_id;
  const preFenceID = actor().operation_id, restoredProofID = actor().operation_id;
  const deletionRestoreID = actor().operation_id;
  let fixtureRouteID: string | undefined;
  t.after(() => {
    if (fixtureRouteID) containers.push(...docker(["ps", "-aq", "--no-trunc", "--filter", `label=grounds.code-route=${fixtureRouteID}`]).split("\n").filter(Boolean));
    // Explicit test-owned resources only; synthetic archive bytes are fixture data.
    for (const id of [exportID, compareID, changedExportID, badCompareID, restoredExportID, guardExportID, restoredCompareID, proofID, preFenceID, restoredProofID]) containers.push(...docker(["ps", "-aq", "--no-trunc", "--filter", `label=grounds.volume-export=${id}`]).split("\n").filter(Boolean));
    for (const id of [restoreID, uncertainRestoreID, failedProbeID, mismatchID, uncertainVolumeID, changedRestoreID, secondRestoreID, deletionRestoreID]) {
      containers.push(...docker(["ps", "-aq", "--no-trunc", "--filter", `label=grounds.volume-restore=${id}`]).split("\n").filter(Boolean));
      volumes.push(...docker(["volume", "ls", "-q", "--filter", `label=grounds.volume-restore=${id}`]).split("\n").filter(Boolean));
    }
    for (const id of containers) if (docker(["ps", "-aq", "--no-trunc"]).split("\n").includes(id)) docker(["rm", "-f", id]);
    for (const id of networks) if (docker(["network", "ls", "-q", "--no-trunc"]).split("\n").includes(id)) docker(["network", "rm", id]);
    for (const name of volumes) if (docker(["volume", "ls", "-q"]).split("\n").includes(name)) docker(["volume", "rm", name]);
  });
  const x = await executionFixture(t), image = process.env.GROUNDS_CODE_POSTGRES_IMAGE!;
  fixtureRouteID = x.route.route_id;
  const executions = new CodeRouteExecutions(x.ledger.store, new DockerRouteEngine());
  const version = await new RepositoryEnvironments(x.ledger.store).save({ ...actor(), environment_id: actor().operation_id,
    repository_id: x.route.repository_id, expected_version: 0, configuration: { name: "volume archive",
      image: process.env.GROUNDS_CODE_DOCKER_IMAGE!, postgres: { image } } });
  const run = await executions.start({ ...actor(), route_id: x.route.route_id, environment_revision_id: version.revision_id, argv: ["true"] });
  containers.push(run.container_id!, run.dependency!.container_id); volumes.push(run.dependency!.volume_name); networks.push(run.dependency!.network_id);
  const sql = (id: string, db: string, query: string) => docker(["exec", id, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db, "-At", "-c", query]);
  sql(run.dependency!.container_id, "task", "CREATE TABLE orders(id int primary key, note text); INSERT INTO orders VALUES (7, 'preserved'); CREATE ROLE archive_reader;");
  sql(run.dependency!.container_id, "task", "CREATE DATABASE upstream;");
  sql(run.dependency!.container_id, "upstream", "CREATE TABLE flags(value text); INSERT INTO flags VALUES ('second database');");
  docker(["exec", run.dependency!.container_id, "sh", "-c", "printf outside-pgdata > /var/lib/postgresql/data/unique-marker"]);
  await executions.stop({ route_id: x.route.route_id, execution_id: run.execution_id });
  await x.ledger.module.abandonDevRun({ ...actor(), dev_run_id: x.route.dev_run_id!, expected_version: 1 });
  await new CodeWorkspaceCleanup(x.ledger.store).end({ ...actor(), instance_id: x.route.instance_id, host_id: x.route.host_id,
    data_root: x.dataRoot, expected_version: 0, retention_days: 0 });
  const service = new CodeRouteServiceCleanup(x.ledger.store), location = { route_id: x.route.route_id, execution_id: run.execution_id };
  await assert.rejects(service.exportVolume({ ...location, ...actor() }), /completed service cleanup/);
  const config = join(x.root, "cli.json");
  writeFileSync(config, JSON.stringify({ version: 2, database: { driver: "sqlite", path: x.ledgerPath,
    expected_database_id: (await x.ledger.store.open()).database_id } }));
  const retirementID = actor().operation_id;
  const retireArgs = ["code-workspace", "service-volume-retire", location.route_id, "--execution-id", location.execution_id,
    "--operation-id", retirementID, "--config", config, "--agent-id", "fixture", "--agent-name", "Fixture", "--json"];
  const retireLines: string[] = [];
  const retireCode = await runCLI(retireArgs, { stdout: line => retireLines.push(line), stderr: () => {} });
  const retirement = JSON.parse(retireLines.join("\n"));
  assert.equal(retireCode, 0, JSON.stringify(retirement)); assertContract("cli-envelope.schema.json", retirement);
  assert.equal(retirement.data.retirement.state, "retiring");
  assert.equal(retirement.data.retirement.volume_name, run.dependency!.volume_name);
  // A fresh OS process and another execution ID must observe the same persistent volume fence.
  const fresh = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    `import {DockerRouteRuntime} from './src/code-route-runtime.ts';
     const run=JSON.parse(process.argv[1]);
     try { await new DockerRouteRuntime(run).prepare(); process.exitCode=9; }
     catch(e) { if (!/retired for managed writes/.test(e.message)) throw e; process.stdout.write('write blocked'); }`,
    JSON.stringify({ ...run, execution_id: actor().operation_id })], { encoding: "utf8", timeout: 30_000 });
  assert.equal(fresh.status, 0, fresh.stderr); assert.equal(fresh.stdout, "write blocked");
  await assert.rejects(new DockerRouteRuntime(run).prepare(), /retired for managed writes/);
  assert.throws(() => new DockerRouteRuntime(run).assertReady(), /retired for managed writes/);
  assert.equal(JSON.parse(docker(["inspect", run.dependency!.container_id]))[0].State.Running, false);
  const retireReplay = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts", ...retireArgs], { encoding: "utf8", timeout: 30_000 });
  assert.equal(retireReplay.status, 0, retireReplay.stderr);
  assert.deepEqual(JSON.parse(retireReplay.stdout).data.retirement, retirement.data.retirement);
  const fenceDirectory = join(x.dataRoot, "runtime", "volume-retirements");
  const fenceFile = join(fenceDirectory, readdirSync(fenceDirectory).find(name => name.endsWith(".json"))!);
  const fenceBytes = readFileSync(fenceFile);
  try {
    writeFileSync(fenceFile, "corrupt fixture receipt");
    await assert.rejects(new DockerRouteRuntime(run).prepare(), /retirement is invalid/);
    const corruptPreview = await service.volumePreview(location);
    assert.equal(corruptPreview.source.volume.managed_writes.state, "unknown");
    assert.ok(corruptPreview.source.blockers.includes("managed_write_state_unknown"));
  } finally { writeFileSync(fenceFile, fenceBytes); }
  const plan = await service.preview(location);
  await service.reclaim({ ...location, ...actor(), expected_version: plan.lifecycle_version, plan_digest: plan.plan_digest });
  const invoke = async () => {
    const lines: string[] = [];
    const code = await runCLI(["code-workspace", "service-volume-export", location.route_id, "--execution-id", location.execution_id,
      "--operation-id", exportID, "--config", config, "--agent-id", "fixture", "--agent-name", "Fixture", "--json"],
      { stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n")); assertContract("cli-envelope.schema.json", envelope); return { code, envelope };
  };
  const foreign = docker(["create", "--pull", "never", "--network", "none", "--mount",
    `type=volume,src=${run.dependency!.volume_name},dst=/var/lib/postgresql/data,readonly`, "--entrypoint", "true", image]);
  containers.push(foreign);
  const blocked = await invoke(); assert.notEqual(blocked.code, 0); assert.match(JSON.stringify(blocked.envelope), /consumers/);
  assert.equal(docker(["ps", "-aq", "--filter", `label=grounds.volume-export=${exportID}`]), "");
  docker(["rm", foreign]);
  // External Docker process boundary: create succeeds in the engine, but its reply is lost.
  const realDocker = spawnSync("which", ["docker"], { encoding: "utf8" }).stdout.trim();
  assert.ok(realDocker.startsWith("/"));
  const shim = join(x.root, "docker-shim"), marker = join(shim, "lost-once"); mkdirSync(shim);
  writeFileSync(join(shim, "docker"), `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const {existsSync,writeFileSync}=require('node:fs');
const args=process.argv.slice(2);
const lose=args[0]==='create' && args.includes(${JSON.stringify(`grounds.volume-export=${exportID}`)}) && !existsSync(${JSON.stringify(marker)});
if(lose) writeFileSync(${JSON.stringify(marker)},'attempted');
const r=spawnSync(${JSON.stringify(realDocker)},args,{stdio:['inherit',lose?'ignore':'inherit','inherit']});
process.exit(lose && r.status===0 ? 42 : (r.status ?? 1));
`, { mode: 0o700 });
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = `${shim}:${priorPath}`;
    const unknown = await invoke(); assert.notEqual(unknown.code, 0); assert.match(JSON.stringify(unknown.envelope), /Docker operation failed/);
  } finally { process.env.PATH = priorPath; }
  assert.ok(docker(["ps", "-aq", "--filter", `label=grounds.volume-export=${exportID}`]));
  const lost = new CodeRouteServiceCleanup(x.ledger.store, execution => {
    const actual = new DockerRouteRuntime(execution);
    return { cleanupSnapshot: () => actual.cleanupSnapshot(), reclaimService: input => actual.reclaimService(input),
      exportVolume: async input => { await actual.exportVolume(input); throw new Error("export reply lost before SQL completion"); } };
  });
  await assert.rejects(lost.exportVolume({ ...location, operation_id: exportID,
    attribution: { kind: "agent", agent_id: "fixture", display_name: "Fixture" } }), /reply lost/);
  const first = await invoke(); assert.equal(first.code, 0, JSON.stringify(first.envelope));
  const archive = first.envelope.data.archive;
  await assert.rejects(service.exportVolume({ ...location, operation_id: exportID,
    attribution: { kind: "agent", agent_id: "changed", display_name: "Changed" } }), /original request/);
  assert.equal(archive.source_volume, run.dependency!.volume_name);
  assert.equal(archive.restore_status, "not_verified");
  const bytes = readFileSync(archive.path);
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, archive.digest);
  assert.equal(bytes.length, archive.size_bytes);
  assert.ok(JSON.parse(readFileSync(join(archive.directory, "manifest.json"), "utf8")).review_after);
  assert.deepEqual((await invoke()).envelope.data.archive, archive);
  assert.equal(docker(["ps", "-aq", "--filter", `label=grounds.volume-export=${exportID}`]), "");
  const restoreCLI = async (action: string, extra: string[]) => {
    const lines: string[] = [];
    const code = await runCLI(["code-workspace", action, location.route_id, "--execution-id", location.execution_id,
      "--config", config, "--json", ...extra], { stdout: line => lines.push(line), stderr: () => {} });
    const envelope = JSON.parse(lines.join("\n")); assertContract("cli-envelope.schema.json", envelope);
    return { code, envelope };
  };
  const previewReply = await restoreCLI("service-volume-preview", []);
  assert.equal(previewReply.code, 0, JSON.stringify(previewReply.envelope));
  const initialVolumes = previewReply.envelope.data.preview;
  assert.equal(initialVolumes.deletion_supported, true);
  assert.equal(initialVolumes.source.volume.name, archive.source_volume);
  assert.equal(initialVolumes.source.volume.state, "matching");
  assert.deepEqual(initialVolumes.source.volume.managed_writes, { state: "retiring", operation_id: retirementID });
  assert.deepEqual(initialVolumes.source.volume.consumers, []);
  assert.ok(initialVolumes.source.blockers.includes("current_contents_not_preserved"));
  assert.deepEqual(initialVolumes.archives.map((a: any) => [a.archive_id, a.integrity]), [[exportID, "valid"]]);
  assert.deepEqual(initialVolumes.restorations, []);
  const comparisonArgs = ["--compare-archive-id", exportID, "--operation-id", compareID, "--agent-id", "fixture", "--agent-name", "Fixture"];
  const compared = await restoreCLI("service-volume-export", comparisonArgs);
  assert.equal(compared.code, 0, JSON.stringify(compared.envelope));
  const comparedArchive = compared.envelope.data.archive;
  assert.equal(comparedArchive.comparison.archive_id, exportID);
  assert.equal(comparedArchive.comparison.archive_digest, archive.digest);
  assert.equal(comparedArchive.comparison.status, "identical");
  assert.notEqual(comparedArchive.path, archive.path);
  assert.deepEqual(readFileSync(comparedArchive.path), bytes);
  assert.deepEqual((await restoreCLI("service-volume-export", comparisonArgs)).envelope.data.archive, comparedArchive);
  const changedTarget = await restoreCLI("service-volume-export", comparisonArgs.map(value => value === exportID ? compareID : value));
  assert.notEqual(changedTarget.code, 0); assert.match(JSON.stringify(changedTarget.envelope), /original request/);
  const checks = [{ id: "orders", database: "task", schema: "public", table: "orders", expected_count: 1 },
    { id: "flags", database: "upstream", schema: "public", table: "flags", expected_count: 1 }];
  const checksFile = join(x.root, "checks.json"); writeFileSync(checksFile, JSON.stringify({ checks }));
  const restoreArgs = ["--checks-file", checksFile, "--archive-id", exportID, "--operation-id", restoreID, "--agent-id", "fixture", "--agent-name", "Fixture"];
  writeFileSync(checksFile, JSON.stringify({ checks: [{ ...checks[0], table: "orders; DROP TABLE orders" }] }));
  const malformed = await restoreCLI("service-volume-restore", restoreArgs);
  assert.notEqual(malformed.code, 0); assert.match(JSON.stringify(malformed.envelope), /simple SQL identifiers/);
  assert.equal(docker(["volume", "ls", "-q", "--filter", `label=grounds.volume-restore=${restoreID}`]), "");
  writeFileSync(checksFile, JSON.stringify({ checks }));
  const injectLostReply = async (condition: string, action: () => Promise<void>) => {
    writeFileSync(join(shim, "docker"), `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2); const lose=(${condition});
const r=spawnSync(${JSON.stringify(realDocker)},args,{stdio:['inherit',lose?'ignore':'inherit','inherit']});
process.exit(lose && r.status===0 ? 42 : (r.status ?? 1));
`, { mode: 0o700 });
    try { process.env.PATH = `${shim}:${priorPath}`; await action(); }
    finally { process.env.PATH = priorPath; }
  };
  const uncertainArgs = restoreArgs.map(value => value === restoreID ? uncertainRestoreID : value);
  await injectLostReply("args[0]==='cp' && args[2]==='-'", async () => {
    const reply = await restoreCLI("service-volume-restore", uncertainArgs);
    assert.notEqual(reply.code, 0); assert.match(JSON.stringify(reply.envelope), /import outcome is unknown/);
  });
  const uncertainContainer = docker(["ps", "-aq", "--no-trunc", "--filter", `label=grounds.volume-restore=${uncertainRestoreID}`]);
  assert.ok(uncertainContainer); assert.equal(JSON.parse(docker(["inspect", uncertainContainer]))[0].State.Status, "created");
  const retryImport = await restoreCLI("service-volume-restore", uncertainArgs);
  assert.notEqual(retryImport.code, 0); assert.match(JSON.stringify(retryImport.envelope), /import outcome is unknown/);
  const pending = await restoreCLI("service-volume-restoration-show", ["--restore-id", uncertainRestoreID]);
  assert.equal(pending.envelope.data.record.phase, "pending"); assert.equal(pending.envelope.data.record.result, undefined);
  assert.equal(pending.envelope.data.record.attempt.phase, "importing");
  assert.equal(pending.envelope.data.record.attempt.failure, "import_unknown");
  const stopID = actor().operation_id;
  const stopArgs = ["--restore-id", uncertainRestoreID, "--operation-id", stopID, "--agent-id", "fixture", "--agent-name", "Fixture"];
  const extraConsumer = docker(["create", "--pull", "never", "--network", "none", "--mount",
    `type=volume,src=grounds-volume-restore-${uncertainRestoreID},dst=/data,readonly`, "--entrypoint", "true", image]);
  containers.push(extraConsumer);
  const blockedStop = await restoreCLI("service-volume-restoration-stop", stopArgs);
  assert.notEqual(blockedStop.code, 0); assert.match(JSON.stringify(blockedStop.envelope), /unexpected consumer/);
  assert.equal((await restoreCLI("service-volume-restoration-show", ["--restore-id", uncertainRestoreID])).envelope.data.record.attempt.phase, "importing");
  docker(["rm", extraConsumer]);
  const halted = await restoreCLI("service-volume-restoration-stop", stopArgs);
  assert.equal(halted.code, 0, JSON.stringify(halted.envelope));
  assert.equal(halted.envelope.data.stopped.volume_state, "retained");
  assert.equal((await restoreCLI("service-volume-restoration-show", ["--restore-id", uncertainRestoreID])).envelope.data.record.attempt.phase, "halted");
  const haltedRetry = await restoreCLI("service-volume-restore", uncertainArgs);
  assert.notEqual(haltedRetry.code, 0); assert.match(JSON.stringify(haltedRetry.envelope), /halted/);
  assert.deepEqual((await restoreCLI("service-volume-restoration-stop", stopArgs)).envelope.data.stopped, halted.envelope.data.stopped);
  assert.ok(docker(["volume", "ls", "-q"]).split("\n").includes(halted.envelope.data.stopped.volume_name));
  // This fixture's retention assertions are complete. Release its data before creating further cases.
  docker(["rm", uncertainContainer]); docker(["volume", "rm", halted.envelope.data.stopped.volume_name]);
  // A fresh operation restores into a different new volume. Creation reply loss is reconcilable.
  await injectLostReply(`args[0]==='create' && args.includes(${JSON.stringify(`grounds.volume-restore=${restoreID}`)})`, async () => {
    const reply = await restoreCLI("service-volume-restore", restoreArgs);
    assert.notEqual(reply.code, 0); assert.match(JSON.stringify(reply.envelope), /Docker operation failed/);
  });
  const lostRestore = new CodeRouteServiceCleanup(x.ledger.store, execution => {
    const actual = new DockerRouteRuntime(execution);
    return { cleanupSnapshot: () => actual.cleanupSnapshot(), reclaimService: input => actual.reclaimService(input),
      restoreVolume: async input => { await actual.restoreVolume(input); throw new Error("restore completion reply lost"); } };
  });
  await assert.rejects(lostRestore.restoreVolume({ ...location, operation_id: restoreID, archive_id: exportID, checks,
    attribution: { kind: "agent", agent_id: "fixture", display_name: "Fixture" } }), /completion reply lost/);
  const restoredReply = await restoreCLI("service-volume-restore", restoreArgs);
  assert.equal(restoredReply.code, 0, JSON.stringify(restoredReply.envelope));
  const changed = await restoreCLI("service-volume-restore", restoreArgs.map(value => value === "fixture" ? "other" : value));
  assert.notEqual(changed.code, 0); assert.match(JSON.stringify(changed.envelope), /original request/);
  const restoration = restoredReply.envelope.data.restoration;
  assert.equal(restoration.archive_digest, archive.digest);
  assert.equal(restoration.verification.kind, "postgres-startup-and-catalog");
  assert.deepEqual(restoration.verification.databases, ["postgres", "task", "upstream"]);
  assert.equal(restoration.container_state, "stopped");
  assert.equal(restoration.verification.business_checks.status, "passed");
  assert.deepEqual(restoration.verification.business_checks.results.map((r: any) => [r.id, r.actual_count, r.status]),
    [["orders", 1, "passed"], ["flags", 1, "passed"]]);
  assert.notEqual(restoration.volume_name, archive.source_volume);
  const restored = restoration.container_id; containers.push(restored); volumes.push(restoration.volume_name);
  assert.equal(JSON.parse(docker(["inspect", restored]))[0].State.Running, false);
  assert.deepEqual((await restoreCLI("service-volume-restore", restoreArgs)).envelope.data.restoration, restoration);
  const shown = await restoreCLI("service-volume-restoration-show", ["--restore-id", restoreID]);
  assert.equal(shown.code, 0, JSON.stringify(shown.envelope));
  assert.deepEqual(shown.envelope.data.record.result, restoration);
  assert.equal(shown.envelope.data.record.phase, "completed");
  const proofArgs = ["--operation-id", proofID, "--compare-archive-id", exportID, "--verified-restore-id", restoreID,
    "--agent-id", "fixture", "--agent-name", "Fixture"];
  const proofExport = await restoreCLI("service-volume-export", proofArgs);
  assert.equal(proofExport.code, 0, JSON.stringify(proofExport.envelope));
  assert.equal(proofExport.envelope.data.archive.capture.retirement_id, retirementID);
  assert.equal(proofExport.envelope.data.archive.capture.verification.restore_id, restoreID);
  const assessed = await restoreCLI("service-volume-assess", ["--archive-id", proofID]);
  assert.equal(assessed.code, 0, JSON.stringify(assessed.envelope));
  assert.equal(assessed.envelope.data.assessment.evidence_status, "complete");
  assert.equal(assessed.envelope.data.assessment.deletion_supported, true);
  assert.deepEqual(assessed.envelope.data.assessment.blockers, []);
  assert.equal(assessed.envelope.data.assessment.source.name, archive.source_volume);
  assert.ok(docker(["volume", "ls", "-q"]).split("\n").includes(archive.source_volume));
  const unbound = await restoreCLI("service-volume-assess", ["--archive-id", compareID]);
  assert.equal(unbound.code, 0); assert.equal(unbound.envelope.data.assessment.evidence_status, "blocked");
  assert.ok(unbound.envelope.data.assessment.blockers.includes("verification_unproven"));
  const assertProofBlocked = async (blocker: string) => {
    const reply = await restoreCLI("service-volume-assess", ["--archive-id", proofID]);
    assert.equal(reply.code, 0, JSON.stringify(reply.envelope));
    assert.equal(reply.envelope.data.assessment.evidence_status, "blocked");
    assert.ok(reply.envelope.data.assessment.blockers.includes(blocker), JSON.stringify(reply.envelope));
  };
  for (const [file, blocker] of [
    [archive.path, "baseline_archive_unavailable"], [proofExport.envelope.data.archive.path, "recheck_archive_unavailable"],
    [join(x.dataRoot, "runtime", "volume-restores", `${restoreID}.json`), "verification_unproven"],
    [join(x.dataRoot, "runtime", "volume-exports", `${proofID}.json`), "recheck_capture_unproven"],
    [fenceFile, "retirement_unproven"],
  ]) {
    const saved = readFileSync(file); writeFileSync(file, "corrupted fixture evidence");
    try { await assertProofBlocked(blocker); } finally { writeFileSync(file, saved); }
  }
  const assessmentConsumer = docker(["create", "--pull", "never", "--network", "none", "--mount",
    `type=volume,src=${archive.source_volume},dst=/var/lib/postgresql/data,readonly`, "--entrypoint", "true", image]);
  containers.push(assessmentConsumer); await assertProofBlocked("source_not_unreferenced"); docker(["rm", assessmentConsumer]);
  // An assessment must use only observations, never a new Docker copy/start/create/remove action.
  writeFileSync(join(shim, "docker"), `#!${process.execPath}
const {spawnSync}=require('node:child_process');const a=process.argv.slice(2);
if(!(['info','ps','inspect'].includes(a[0]) || (a[0]==='volume' && ['ls','inspect'].includes(a[1])))){process.exit(43);}
const r=spawnSync(${JSON.stringify(realDocker)},a,{stdio:'inherit'});process.exit(r.status ?? 1);
`, { mode: 0o700 });
  try {
    process.env.PATH = `${shim}:${priorPath}`;
    const readOnly = await restoreCLI("service-volume-assess", ["--archive-id", proofID]);
    assert.equal(readOnly.code, 0, JSON.stringify(readOnly.envelope));
    assert.equal(readOnly.envelope.data.assessment.evidence_status, "complete");
    assert.equal(readOnly.envelope.data.assessment.current_contents, "not_rechecked");
  } finally { process.env.PATH = priorPath; }
  const wrongVerification = await restoreCLI("service-volume-export", [...proofArgs.map(value =>
    value === proofID ? actor().operation_id : value === exportID ? compareID : value)]);
  assert.notEqual(wrongVerification.code, 0); assert.match(JSON.stringify(wrongVerification.envelope), /exact comparison archive/);
  writeFileSync(checksFile, JSON.stringify({ checks: [{ ...checks[0], expected_count: 2 },
    { id: "missing", database: "task", schema: "public", table: "missing", expected_count: 0 }] }));
  const drift = await restoreCLI("service-volume-restore", restoreArgs);
  assert.notEqual(drift.code, 0); assert.match(JSON.stringify(drift.envelope), /original request/);
  const mismatch = await restoreCLI("service-volume-restore", restoreArgs.map(value => value === restoreID ? mismatchID : value));
  assert.equal(mismatch.code, 0, JSON.stringify(mismatch.envelope));
  assert.equal(mismatch.envelope.data.restoration.verification.business_checks.status, "failed");
  const failedVerification = await restoreCLI("service-volume-export", proofArgs.map(value =>
    value === proofID ? actor().operation_id : value === restoreID ? mismatchID : value));
  assert.notEqual(failedVerification.code, 0); assert.match(JSON.stringify(failedVerification.envelope), /passed fixed business checks/);
  assert.deepEqual(mismatch.envelope.data.restoration.verification.business_checks.results.map((r: any) => [r.actual_count, r.status]), [[1, "failed"], [null, "error"]]);
  assert.equal(JSON.parse(docker(["inspect", mismatch.envelope.data.restoration.container_id]))[0].State.Running, false);
  const mismatchArchive = mismatch.envelope.data.restoration;
  assert.ok(docker(["volume", "ls", "-q"]).split("\n").includes(mismatchArchive.volume_name));
  docker(["rm", mismatchArchive.container_id]); docker(["volume", "rm", mismatchArchive.volume_name]);
  writeFileSync(checksFile, JSON.stringify({ checks }));
  const restoredSQL = (db: string, query: string) => docker(["exec", restored, "psql", "-h", "/tmp", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db, "-At", "-c", query]);
  docker(["start", restored]);
  for (let i = 0; i < 60; i++) {
    try { docker(["exec", restored, "pg_isready", "-h", "/tmp", "-U", "postgres"]); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.equal(restoredSQL("task", "SELECT id || ':' || note FROM orders"), "7:preserved");
  assert.equal(restoredSQL("upstream", "SELECT value FROM flags"), "second database");
  assert.equal(restoredSQL("task", "SELECT rolname FROM pg_roles WHERE rolname = 'archive_reader'"), "archive_reader");
  assert.equal(docker(["exec", restored, "cat", "/var/lib/postgresql/data/unique-marker"]), "outside-pgdata");
  restoredSQL("task", "UPDATE orders SET note = 'changed only in restore'");
  assert.deepEqual((await restoreCLI("service-volume-restore", restoreArgs)).envelope.data.restoration, restoration);
  assert.equal(restoredSQL("task", "SELECT note FROM orders"), "changed only in restore");
  assert.ok(docker(["volume", "ls", "-q"]).split("\n").includes(archive.source_volume));
  assert.deepEqual((await invoke()).envelope.data.archive, archive);
  // Only this disposable fixture boots the original to prove restored writes did not change its SQL data.
  const source = docker(["create", "--pull", "never", "--network", "none", "--mount",
    `type=volume,src=${archive.source_volume},dst=/var/lib/postgresql/data`, "--env", "PGDATA=/var/lib/postgresql/data/pgdata", image]);
  containers.push(source); docker(["start", source]);
  for (let i = 0; i < 60; i++) {
    try { docker(["exec", source, "pg_isready", "-U", "postgres"]); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.equal(sql(source, "task", "SELECT note FROM orders WHERE id = 7"), "preserved");
  sql(source, "task", "INSERT INTO orders VALUES (8, 'new source data')");
  docker(["exec", source, "sh", "-c", "printf new-source-marker > /var/lib/postgresql/data/unique-marker"]);
  docker(["stop", "--time", "5", source]); docker(["rm", source]);
  const changedExportArgs = [...comparisonArgs.map(value => value === compareID ? changedExportID : value), "--verified-restore-id", restoreID];
  await injectLostReply(`args[0]==='create' && args.includes(${JSON.stringify(`grounds.volume-export=${changedExportID}`)})`, async () => {
    const lostComparison = await restoreCLI("service-volume-export", changedExportArgs);
    assert.notEqual(lostComparison.code, 0);
  });
  const changedExportReply = await restoreCLI("service-volume-export", changedExportArgs);
  assert.equal(changedExportReply.code, 0, JSON.stringify(changedExportReply.envelope));
  const changedArchive = changedExportReply.envelope.data.archive;
  assert.equal(changedArchive.comparison.status, "different");
  assert.equal(changedArchive.comparison.algorithm, "docker-tar-sha256/v1");
  assert.notEqual(changedArchive.digest, archive.digest);
  assert.equal(changedArchive.restore_status, "not_verified");
  const changedAssessment = await restoreCLI("service-volume-assess", ["--archive-id", changedExportID]);
  assert.equal(changedAssessment.code, 0, JSON.stringify(changedAssessment.envelope));
  assert.equal(changedAssessment.envelope.data.assessment.evidence_status, "blocked");
  assert.ok(changedAssessment.envelope.data.assessment.blockers.includes("recheck_differs"));
  const differingDeleteArgs = ["--archive-id", proofID, "--expected-version", String(plan.lifecycle_version),
    "--operation-id", actor().operation_id, "--agent-id", "fixture", "--agent-name", "Fixture"];
  const differingDeletion = await restoreCLI("service-volume-delete", differingDeleteArgs);
  assert.notEqual(differingDeletion.code, 0); assert.match(JSON.stringify(differingDeletion.envelope), /Fresh contents differ/);
  const differingRecheck = differingDeletion.envelope.error.details;
  assert.ok(existsSync(differingRecheck.target_path));
  assert.ok(docker(["volume", "ls", "-q"]).split("\n").includes(archive.source_volume));
  const differingInventory = await restoreCLI("service-volume-preview", []);
  assert.equal(differingInventory.envelope.data.preview.archives.find((a: any) => a.archive_id === differingRecheck.recheck_archive_id).comparison.status, "different");
  assert.notEqual((await restoreCLI("service-volume-delete", differingDeleteArgs)).code, 0);
  assert.deepEqual(readFileSync(archive.path), bytes);
  assert.deepEqual((await restoreCLI("service-volume-export", comparisonArgs)).envelope.data.archive, comparedArchive); // historical identical, no current-volume claim

  const failedArgs = restoreArgs.map(value => value === restoreID ? failedProbeID : value);
  await injectLostReply("args[0]==='exec' && args.includes('SELECT count(*) FROM pg_catalog.pg_class')", async () => {
    const reply = await restoreCLI("service-volume-restore", failedArgs);
    assert.notEqual(reply.code, 0); assert.match(JSON.stringify(reply.envelope), /probe failed/);
  });
  const failedContainer = docker(["ps", "-aq", "--no-trunc", "--filter", `label=grounds.volume-restore=${failedProbeID}`]);
  assert.ok(failedContainer); assert.equal(JSON.parse(docker(["inspect", failedContainer]))[0].State.Running, false);
  const failedReplay = await restoreCLI("service-volume-restore", failedArgs);
  assert.notEqual(failedReplay.code, 0); assert.match(JSON.stringify(failedReplay.envelope), /probe failed/);
  const failedRecord = await restoreCLI("service-volume-restoration-show", ["--restore-id", failedProbeID]);
  assert.equal(failedRecord.envelope.data.record.phase, "pending"); assert.equal(failedRecord.envelope.data.record.result, undefined);
  assert.equal(failedRecord.envelope.data.record.attempt.phase, "failed");
  assert.equal(failedRecord.envelope.data.record.attempt.failure, "probe_failed");
  const completedStop = await restoreCLI("service-volume-restoration-stop", stopArgs.map(value => value === uncertainRestoreID ? restoreID : value === stopID ? actor().operation_id : value));
  assert.notEqual(completedStop.code, 0); assert.match(JSON.stringify(completedStop.envelope), /completed/);
  assert.equal(JSON.parse(docker(["inspect", restored]))[0].State.Running, true);
  const volumesBefore = await restoreCLI("service-volume-preview", []);
  assert.equal(volumesBefore.code, 0, JSON.stringify(volumesBefore.envelope));
  const inventory = volumesBefore.envelope.data.preview;
  assert.equal(inventory.restorations.length, 4);
  assert.equal(inventory.archives.find((a: any) => a.archive_id === changedExportID).comparison.status, "different");
  assert.ok(inventory.source.blockers.includes("current_contents_not_preserved"));
  const passedVolume = inventory.restorations.find((r: any) => r.restore_id === restoreID);
  assert.equal(passedVolume.business_status, "passed");
  assert.equal(passedVolume.attempt.phase, "completed");
  assert.ok(passedVolume.blockers.includes("current_contents_not_preserved"));
  assert.ok(passedVolume.blockers.includes("volume_has_consumers"));
  assert.deepEqual(passedVolume.volume.consumers, [restored]);
  assert.equal(inventory.restorations.find((r: any) => r.restore_id === mismatchID).business_status, "failed");
  const unknownImport = inventory.restorations.find((r: any) => r.restore_id === uncertainRestoreID);
  assert.equal(unknownImport.attempt.phase, "halted");
  assert.equal(unknownImport.volume.state, "missing"); // fixture released after retention assertions; history remains
  assert.ok(unknownImport.blockers.includes("import_outcome_unknown"));
  assert.equal(inventory.restorations.find((r: any) => r.restore_id === failedProbeID).attempt.failure, "probe_failed");
  assert.equal(JSON.parse(docker(["inspect", restored]))[0].State.Running, true);
  assert.equal(restoredSQL("task", "SELECT note FROM orders"), "changed only in restore");
  await injectLostReply("args[0]==='info'", async () => {
    const unavailable = await restoreCLI("service-volume-preview", []);
    assert.equal(unavailable.code, 0, JSON.stringify(unavailable.envelope));
    assert.equal(unavailable.envelope.data.preview.source.volume.state, "unknown");
    assert.equal(unavailable.envelope.data.preview.source.volume.consumers, null);
    assert.ok(unavailable.envelope.data.preview.restorations.every((r: any) => r.volume.state === "unknown"));
  });
  const unknownVolumeArgs = restoreArgs.map(value => value === restoreID ? uncertainVolumeID : value);
  await injectLostReply("args[0]==='volume' && args[1]==='create'", async () => {
    const lostVolume = await restoreCLI("service-volume-restore", unknownVolumeArgs);
    assert.notEqual(lostVolume.code, 0);
  });
  const unknownVolumePreview = await restoreCLI("service-volume-preview", []);
  assert.equal(unknownVolumePreview.code, 0, JSON.stringify(unknownVolumePreview.envelope));
  const uncertainVolume = unknownVolumePreview.envelope.data.preview.restorations.find((r: any) => r.restore_id === uncertainVolumeID);
  assert.equal(uncertainVolume.attempt.phase, "volume-creating");
  assert.equal(uncertainVolume.volume.state, "unknown");
  // Restrict the actual external Docker boundary to reads; simulate a replaced source identity in replies only.
  const deniedWrites = join(shim, "unexpected-write");
  writeFileSync(join(shim, "docker"), `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const {writeFileSync}=require('node:fs');
const args=process.argv.slice(2);
if(!(['info','ps'].includes(args[0]) || (args[0]==='volume' && ['ls','inspect'].includes(args[1])))) {
  writeFileSync(${JSON.stringify(deniedWrites)},JSON.stringify(args)); process.exit(42);
}
const r=spawnSync(${JSON.stringify(realDocker)},args,{encoding:'utf8'});
let out=r.stdout;
if(r.status===0 && args[0]==='volume' && args[1]==='inspect' && args[2]===${JSON.stringify(archive.source_volume)}) {
  const data=JSON.parse(out); data[0].CreatedAt='2000-01-01T00:00:00Z'; out=JSON.stringify(data);
}
process.stdout.write(out ?? ''); process.exit(r.status ?? 1);
`, { mode: 0o700 });
  try {
    process.env.PATH = `${shim}:${priorPath}`;
    const changedIdentity = await restoreCLI("service-volume-preview", []);
    assert.equal(changedIdentity.code, 0, JSON.stringify(changedIdentity.envelope));
    assert.equal(changedIdentity.envelope.data.preview.source.volume.state, "identity_changed");
    assert.ok(changedIdentity.envelope.data.preview.restorations.some((r: any) => r.restore_id === restoreID && r.volume.state === "matching"));
    assert.equal(existsSync(deniedWrites), false);
  } finally { process.env.PATH = priorPath; }
  const corrupt = Buffer.from(bytes); corrupt[1024] ^= 1; writeFileSync(archive.path, corrupt);
  // Stopping an incomplete attempt needs its resource identity, not readable archive bytes.
  docker(["start", failedContainer]);
  const failedStopID = actor().operation_id;
  const failedStopArgs = stopArgs.map(value => value === uncertainRestoreID ? failedProbeID : value === stopID ? failedStopID : value);
  await injectLostReply(`args[0]==='stop' && args.includes(${JSON.stringify(failedContainer)})`, async () => {
    const lostStop = await restoreCLI("service-volume-restoration-stop", failedStopArgs);
    assert.notEqual(lostStop.code, 0);
  });
  assert.equal((await restoreCLI("service-volume-restoration-show", ["--restore-id", failedProbeID])).envelope.data.record.attempt.phase, "halting");
  const interruptedResume = await restoreCLI("service-volume-restore", failedArgs);
  assert.notEqual(interruptedResume.code, 0); assert.match(JSON.stringify(interruptedResume.envelope), /halting/);
  const changedStop = await restoreCLI("service-volume-restoration-stop", failedStopArgs.map(value => value === "fixture" ? "other" : value));
  assert.notEqual(changedStop.code, 0); assert.match(JSON.stringify(changedStop.envelope), /original request/);
  const stoppedFailure = await restoreCLI("service-volume-restoration-stop", failedStopArgs);
  assert.equal(stoppedFailure.code, 0, JSON.stringify(stoppedFailure.envelope));
  assert.equal(JSON.parse(docker(["inspect", failedContainer]))[0].State.Running, false);
  assert.ok(docker(["volume", "ls", "-q"]).split("\n").includes(stoppedFailure.envelope.data.stopped.volume_name));
  docker(["start", failedContainer]);
  assert.deepEqual((await restoreCLI("service-volume-restoration-stop", failedStopArgs)).envelope.data.stopped, stoppedFailure.envelope.data.stopped);
  assert.equal(JSON.parse(docker(["inspect", failedContainer]))[0].State.Running, true); // historical replay has no effects
  docker(["stop", "--time", "5", failedContainer]);
  docker(["rm", failedContainer]); docker(["volume", "rm", stoppedFailure.envelope.data.stopped.volume_name]);
  const badComparison = await restoreCLI("service-volume-export", comparisonArgs.map(value => value === compareID ? badCompareID : value));
  assert.notEqual(badComparison.code, 0); assert.match(JSON.stringify(badComparison.envelope), /intact completed archive/);
  assert.equal(docker(["ps", "-aq", "--filter", `label=grounds.volume-export=${badCompareID}`]), "");
  const badRestoreID = actor().operation_id;
  const badRestore = await restoreCLI("service-volume-restore", ["--archive-id", exportID, "--operation-id", badRestoreID,
    "--agent-id", "fixture", "--agent-name", "Fixture"]);
  assert.notEqual(badRestore.code, 0);
  assert.equal(docker(["volume", "ls", "-q", "--filter", `label=grounds.volume-restore=${badRestoreID}`]), "");
  // The new archive restores independently even though the old comparison target is now corrupt.
  writeFileSync(checksFile, JSON.stringify({ checks: checks.map(check => check.id === "orders" ? { ...check, expected_count: 2 } : check) }));
  const changedRestore = await restoreCLI("service-volume-restore", restoreArgs.map(value => value === exportID ? changedExportID : value === restoreID ? changedRestoreID : value));
  assert.equal(changedRestore.code, 0, JSON.stringify(changedRestore.envelope));
  const recovered = changedRestore.envelope.data.restoration;
  assert.equal(recovered.verification.business_checks.status, "passed");
  docker(["start", recovered.container_id]);
  for (let i = 0; i < 60; i++) {
    try { docker(["exec", recovered.container_id, "pg_isready", "-h", "/tmp", "-U", "postgres"]); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.equal(docker(["exec", recovered.container_id, "psql", "-h", "/tmp", "-U", "postgres", "-d", "task", "-At", "-c", "SELECT note FROM orders WHERE id=8"]), "new source data");
  assert.equal(docker(["exec", recovered.container_id, "cat", "/var/lib/postgresql/data/unique-marker"]), "new-source-marker");
  docker(["exec", recovered.container_id, "psql", "-h", "/tmp", "-U", "postgres", "-d", "task", "-v", "ON_ERROR_STOP=1", "-c", "INSERT INTO orders VALUES (9, 'written after restoration')"]);
  docker(["exec", recovered.container_id, "sh", "-c", "printf restored-marker > /var/lib/postgresql/data/unique-marker"]);
  const restoredExportArgs = ["--restore-id", changedRestoreID, "--operation-id", restoredExportID, "--agent-id", "fixture", "--agent-name", "Fixture"];
  const liveExport = await restoreCLI("service-volume-export", restoredExportArgs);
  assert.notEqual(liveExport.code, 0); assert.match(JSON.stringify(liveExport.envelope), /stopped restoration container/);
  assert.equal(docker(["ps", "-aq", "--filter", `label=grounds.volume-export=${restoredExportID}`]), "");
  docker(["stop", "--time", "5", recovered.container_id]);
  const extraReader = docker(["create", "--pull", "never", "--network", "none", "--mount",
    `type=volume,src=${recovered.volume_name},dst=/var/lib/postgresql/data,readonly`, "--entrypoint", "true", image]);
  containers.push(extraReader);
  const busyExport = await restoreCLI("service-volume-export", restoredExportArgs);
  assert.notEqual(busyExport.code, 0); assert.match(JSON.stringify(busyExport.envelope), /another consumer/);
  docker(["rm", extraReader]);
  const cleanupLifecycle = new CodeWorkspaceCleanup(x.ledger.store);
  const endLocation = { instance_id: x.route.instance_id, host_id: x.route.host_id, data_root: x.dataRoot };
  await cleanupLifecycle.end({ ...actor(), ...endLocation, expected_version: plan.lifecycle_version, pinned: true });
  const pinnedCleanup = await restoreCLI("service-volume-restoration-cleanup", ["--restore-id", changedRestoreID, "--early",
    "--expected-version", String(plan.lifecycle_version + 1), "--operation-id", actor().operation_id, "--agent-id", "fixture", "--agent-name", "Fixture"]);
  assert.notEqual(pinnedCleanup.code, 0); assert.match(JSON.stringify(pinnedCleanup.envelope), /lifecycle version, retention or pin/);
  await cleanupLifecycle.end({ ...actor(), ...endLocation, expected_version: plan.lifecycle_version + 1, pinned: false, retention_days: 7 });
  const retainedCleanup = await restoreCLI("service-volume-restoration-cleanup", ["--restore-id", changedRestoreID,
    "--expected-version", String(plan.lifecycle_version + 2), "--operation-id", actor().operation_id, "--agent-id", "fixture", "--agent-name", "Fixture"]);
  assert.notEqual(retainedCleanup.code, 0); assert.match(JSON.stringify(retainedCleanup.envelope), /lifecycle version, retention or pin/);
  const earlyCleanup = await restoreCLI("service-volume-restoration-cleanup", ["--restore-id", changedRestoreID, "--early",
    "--expected-version", String(plan.lifecycle_version + 2), "--operation-id", actor().operation_id, "--agent-id", "fixture", "--agent-name", "Fixture"]);
  assert.notEqual(earlyCleanup.code, 0); assert.match(JSON.stringify(earlyCleanup.envelope), /persistent volume retirement/);
  await cleanupLifecycle.end({ ...actor(), ...endLocation, expected_version: plan.lifecycle_version + 2, retention_days: 0 });
  const cleanupArgs = ["--restore-id", changedRestoreID, "--expected-version", String(plan.lifecycle_version + 3),
    "--operation-id", actor().operation_id, "--agent-id", "fixture", "--agent-name", "Fixture"];
  const notRetired = await restoreCLI("service-volume-restoration-cleanup", cleanupArgs);
  assert.notEqual(notRetired.code, 0); assert.match(JSON.stringify(notRetired.envelope), /persistent volume retirement/);
  const preFenceArgs = restoredExportArgs.map(value => value === restoredExportID ? preFenceID : value);
  const preFenceArchive = await restoreCLI("service-volume-export", preFenceArgs);
  assert.equal(preFenceArchive.code, 0, JSON.stringify(preFenceArchive.envelope));
  assert.equal(preFenceArchive.envelope.data.archive.capture, undefined);
  const restoredRetirementArgs = ["--restore-id", changedRestoreID, "--operation-id", actor().operation_id, "--agent-id", "fixture", "--agent-name", "Fixture"];
  const retiredRestore = await restoreCLI("service-volume-retire", restoredRetirementArgs);
  assert.equal(retiredRestore.code, 0, JSON.stringify(retiredRestore.envelope));
  assert.equal(retiredRestore.envelope.data.retirement.volume_name, recovered.volume_name);
  assert.equal(retiredRestore.envelope.data.retirement.source_restore_id, changedRestoreID);
  const preFenceReplay = await restoreCLI("service-volume-export", preFenceArgs);
  assert.equal(preFenceReplay.code, 0, JSON.stringify(preFenceReplay.envelope));
  assert.deepEqual(preFenceReplay.envelope.data.archive, preFenceArchive.envelope.data.archive);
  const oldCapture = await restoreCLI("service-volume-assess", ["--archive-id", preFenceID]);
  assert.equal(oldCapture.code, 0, JSON.stringify(oldCapture.envelope));
  assert.ok(oldCapture.envelope.data.assessment.blockers.includes("recheck_not_after_retirement"));
  const protectedRestore = await restoreCLI("service-volume-preview", []);
  assert.equal(protectedRestore.code, 0, JSON.stringify(protectedRestore.envelope));
  assert.equal(protectedRestore.envelope.data.preview.restorations.find((item: any) => item.restore_id === changedRestoreID).volume.managed_writes.state, "retiring");
  assert.deepEqual((await restoreCLI("service-volume-retire", restoredRetirementArgs)).envelope.data.retirement, retiredRestore.envelope.data.retirement);
  const restoreHistory = await restoreCLI("service-volume-restore", restoreArgs.map(value => value === exportID ? changedExportID : value === restoreID ? changedRestoreID : value));
  assert.equal(restoreHistory.code, 0, JSON.stringify(restoreHistory.envelope));
  assert.deepEqual(restoreHistory.envelope.data.restoration, recovered);
  const incompleteExport = await restoreCLI("service-volume-export", restoredExportArgs.map(value => value === changedRestoreID ? uncertainRestoreID : value === restoredExportID ? guardExportID : value));
  assert.notEqual(incompleteExport.code, 0); assert.match(JSON.stringify(incompleteExport.envelope), /completed restoration/);
  const wrongSourceCompare = await restoreCLI("service-volume-export", [...restoredExportArgs, "--compare-archive-id", compareID]);
  assert.notEqual(wrongSourceCompare.code, 0); assert.match(JSON.stringify(wrongSourceCompare.envelope), /intact completed archive from this source/);
  // The old input archive is no longer needed to preserve the restored volume's new data.
  writeFileSync(changedArchive.path, "corrupted old restore input");
  await injectLostReply(`args[0]==='create' && args.includes(${JSON.stringify(`grounds.volume-export=${restoredExportID}`)})`, async () => {
    const lostRestoredExport = await restoreCLI("service-volume-export", restoredExportArgs);
    assert.notEqual(lostRestoredExport.code, 0);
  });
  const restoredExport = await restoreCLI("service-volume-export", restoredExportArgs);
  assert.equal(restoredExport.code, 0, JSON.stringify(restoredExport.envelope));
  const restoredArchive = restoredExport.envelope.data.archive;
  assert.equal(restoredArchive.source_restore_id, changedRestoreID);
  assert.equal(restoredArchive.source_volume, recovered.volume_name);
  assert.notEqual(restoredArchive.source_volume, archive.source_volume);
  assert.deepEqual((await restoreCLI("service-volume-export", restoredExportArgs)).envelope.data.archive, restoredArchive);
  const movedSource = await restoreCLI("service-volume-export", restoredExportArgs.map(value => value === changedRestoreID ? restoreID : value));
  assert.notEqual(movedSource.code, 0); assert.match(JSON.stringify(movedSource.envelope), /original request/);
  const restoredComparison = await restoreCLI("service-volume-export", [...restoredExportArgs.map(value => value === restoredExportID ? restoredCompareID : value), "--compare-archive-id", restoredExportID]);
  assert.equal(restoredComparison.code, 0, JSON.stringify(restoredComparison.envelope));
  assert.equal(restoredComparison.envelope.data.archive.comparison.status, "identical");
  assert.equal(restoredComparison.envelope.data.archive.source_restore_id, changedRestoreID);
  const stale = await restoreCLI("service-volume-restoration-cleanup", cleanupArgs.map((value, index) =>
    cleanupArgs[index - 1] === "--expected-version" ? String(plan.lifecycle_version + 1) : cleanupArgs[index - 1] === "--operation-id" ? actor().operation_id : value));
  assert.notEqual(stale.code, 0); assert.match(JSON.stringify(stale.envelope), /lifecycle version/);
  const incomplete = await restoreCLI("service-volume-restoration-cleanup", cleanupArgs.map((value, index) =>
    value === changedRestoreID ? uncertainRestoreID : cleanupArgs[index - 1] === "--operation-id" ? actor().operation_id : value));
  assert.notEqual(incomplete.code, 0); assert.match(JSON.stringify(incomplete.envelope), /completed restoration/);
  docker(["update", "--restart", "always", recovered.container_id]);
  const unsafeRestart = await restoreCLI("service-volume-restoration-cleanup", cleanupArgs);
  assert.notEqual(unsafeRestart.code, 0); assert.match(JSON.stringify(unsafeRestart.envelope), /stopped restoration container/);
  docker(["update", "--restart", "no", recovered.container_id]);
  // Fault injection at the external Docker boundary: unexpected layer changes must retain the resource.
  writeFileSync(join(shim, "docker"), `#!${process.execPath}
const {spawnSync}=require('node:child_process'); const args=process.argv.slice(2);
if(args[0]==='diff'){console.log('A /unique-unpreserved-file');process.exit(0);}
const r=spawnSync(${JSON.stringify(realDocker)},args,{stdio:'inherit'});process.exit(r.status ?? 1);
`, { mode: 0o700 });
  try {
    process.env.PATH = `${shim}:${priorPath}`;
    const dirty = await restoreCLI("service-volume-restoration-cleanup", cleanupArgs);
    assert.notEqual(dirty.code, 0); assert.match(JSON.stringify(dirty.envelope), /unpreserved filesystem changes/);
  } finally { process.env.PATH = priorPath; }
  await injectLostReply("args[0]==='logs'", async () => {
    const unavailable = await restoreCLI("service-volume-restoration-cleanup", cleanupArgs);
    assert.notEqual(unavailable.code, 0); assert.match(JSON.stringify(unavailable.envelope), /available restoration diagnostics/);
  });
  assert.equal(docker(["ps", "-aq", "--no-trunc", "--filter", `id=${recovered.container_id}`]), recovered.container_id);
  const expectedLogs = spawnSync("docker", ["logs", "--timestamps", recovered.container_id]);
  assert.equal(expectedLogs.status, 0);
  await injectLostReply(`args[0]==='rm' && args.includes(${JSON.stringify(recovered.container_id)})`, async () => {
    const lost = await restoreCLI("service-volume-restoration-cleanup", cleanupArgs);
    assert.notEqual(lost.code, 0);
    assert.equal(docker(["ps", "-aq", "--no-trunc", "--filter", `id=${recovered.container_id}`]), "", JSON.stringify(lost.envelope));
  });
  const replacement = docker(["create", "--pull", "never", "--name", recovered.volume_name, "--network", "none",
    "--mount", `type=volume,src=${recovered.volume_name},dst=/var/lib/postgresql/data,readonly`, "--entrypoint", "true", image]);
  containers.push(replacement);
  const replaced = await restoreCLI("service-volume-restoration-cleanup", cleanupArgs);
  assert.notEqual(replaced.code, 0); assert.match(JSON.stringify(replaced.envelope), /another consumer|identity was replaced/);
  assert.equal(docker(["ps", "-aq", "--no-trunc", "--filter", `id=${replacement}`]), replacement);
  docker(["rm", replacement]);
  const cleaned = await restoreCLI("service-volume-restoration-cleanup", cleanupArgs);
  assert.equal(cleaned.code, 0, JSON.stringify(cleaned.envelope));
  const cleanup = cleaned.envelope.data.cleanup;
  assert.equal(cleanup.container.id, recovered.container_id);
  assert.equal(cleanup.container.state, "removed");
  assert.equal(cleanup.volume.state, "retained");
  assert.equal(JSON.parse(docker(["volume", "inspect", recovered.volume_name]))[0].CreatedAt, recovered.volume_created_at);
  const savedLogs = JSON.parse(readFileSync(join(cleanup.diagnostics.directory, "postgres-log.json"), "utf8"));
  assert.equal(savedLogs.stdout, expectedLogs.stdout.toString("base64"));
  assert.equal(savedLogs.stderr, expectedLogs.stderr.toString("base64"));
  assert.ok(Date.parse(cleanup.diagnostics.review_after) > Date.now());
  assert.deepEqual((await restoreCLI("service-volume-restoration-cleanup", cleanupArgs)).envelope.data.cleanup, cleanup);
  const replayReplacement = docker(["create", "--pull", "never", "--name", recovered.volume_name, "--network", "none",
    "--mount", `type=volume,src=${recovered.volume_name},dst=/var/lib/postgresql/data,readonly`, "--entrypoint", "true", image]);
  containers.push(replayReplacement);
  assert.deepEqual((await restoreCLI("service-volume-restoration-cleanup", cleanupArgs)).envelope.data.cleanup, cleanup);
  assert.equal(docker(["ps", "-aq", "--no-trunc", "--filter", `id=${replayReplacement}`]), replayReplacement);
  const savedBytes = readFileSync(join(cleanup.diagnostics.directory, "postgres-log.json"));
  writeFileSync(join(cleanup.diagnostics.directory, "postgres-log.json"), "damaged archive");
  const damagedLogs = await restoreCLI("service-volume-restoration-cleanup", cleanupArgs);
  assert.notEqual(damagedLogs.code, 0); assert.match(JSON.stringify(damagedLogs.envelope), /diagnostics integrity/);
  writeFileSync(join(cleanup.diagnostics.directory, "postgres-log.json"), savedBytes);
  const changedRequest = await restoreCLI("service-volume-restoration-cleanup", cleanupArgs.map((value, index) =>
    cleanupArgs[index - 1] === "--agent-name" ? "Changed" : value));
  assert.notEqual(changedRequest.code, 0); assert.match(JSON.stringify(changedRequest.envelope), /original request/);
  docker(["rm", replayReplacement]);
  const afterCleanup = await restoreCLI("service-volume-export", restoredExportArgs.map(value => value === restoredExportID ? guardExportID : value));
  assert.equal(afterCleanup.code, 0, JSON.stringify(afterCleanup.envelope));
  assert.equal(afterCleanup.envelope.data.archive.source_volume, recovered.volume_name);
  assert.deepEqual((await restoreCLI("service-volume-export", restoredExportArgs)).envelope.data.archive, restoredArchive); // historical replay after source container removal

  writeFileSync(checksFile, JSON.stringify({ checks: checks.map(check => check.id === "orders" ? { ...check, expected_count: 3 } : check) }));
  const second = await restoreCLI("service-volume-restore", restoreArgs.map(value => value === exportID ? restoredExportID : value === restoreID ? secondRestoreID : value));
  assert.equal(second.code, 0, JSON.stringify(second.envelope));
  const secondResult = second.envelope.data.restoration;
  assert.equal(secondResult.verification.business_checks.status, "passed");
  docker(["start", secondResult.container_id]);
  for (let i = 0; i < 60; i++) {
    try { docker(["exec", secondResult.container_id, "pg_isready", "-h", "/tmp", "-U", "postgres"]); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.equal(docker(["exec", secondResult.container_id, "psql", "-h", "/tmp", "-U", "postgres", "-d", "task", "-At", "-c", "SELECT note FROM orders WHERE id=9"]), "written after restoration");
  assert.equal(docker(["exec", secondResult.container_id, "cat", "/var/lib/postgresql/data/unique-marker"]), "restored-marker");
  docker(["stop", "--time", "5", secondResult.container_id]);
  docker(["rm", secondResult.container_id]); docker(["volume", "rm", secondResult.volume_name]);
  const restoredProof = await restoreCLI("service-volume-export", [...restoredExportArgs.map(value => value === restoredExportID ? restoredProofID : value),
    "--compare-archive-id", restoredExportID, "--verified-restore-id", secondRestoreID]);
  assert.equal(restoredProof.code, 0, JSON.stringify(restoredProof.envelope));
  const restoredAssessment = await restoreCLI("service-volume-assess", ["--archive-id", restoredProofID]);
  assert.equal(restoredAssessment.code, 0, JSON.stringify(restoredAssessment.envelope));
  assert.equal(restoredAssessment.envelope.data.assessment.evidence_status, "complete", JSON.stringify(restoredAssessment.envelope));
  assert.equal(restoredAssessment.envelope.data.assessment.source.name, recovered.volume_name);
  const deleteArgs = ["--archive-id", restoredProofID, "--expected-version", String(plan.lifecycle_version + 3),
    "--operation-id", actor().operation_id, "--agent-id", "fixture", "--agent-name", "Fixture"];
  const wrongVersion = await restoreCLI("service-volume-delete", deleteArgs.map(value => value === String(plan.lifecycle_version + 3) ? "999" : value));
  assert.notEqual(wrongVersion.code, 0); assert.match(JSON.stringify(wrongVersion.envelope), /lifecycle/);
  const beforeDeletion = await restoreCLI("service-volume-preview", []);
  const beforeArchiveIDs = new Set(beforeDeletion.envelope.data.preview.archives.map((a: any) => a.archive_id));
  // Refuse the first rm before any engine effect, then retry with a fresh capture.
  const denyShim = join(x.root, "deny-volume-rm"); mkdirSync(denyShim);
  writeFileSync(join(denyShim, "docker"), `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const args=process.argv.slice(2);
if(args[0]==='volume' && args[1]==='rm' && args.includes(${JSON.stringify(recovered.volume_name)})) process.exit(42);
const r=spawnSync(${JSON.stringify(realDocker)},args,{stdio:'inherit'});process.exit(r.status??1);
`, { mode: 0o700 });
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = `${denyShim}:${originalPath}`;
    const denied = await restoreCLI("service-volume-delete", deleteArgs);
    assert.notEqual(denied.code, 0);
  } finally { process.env.PATH = originalPath; }
  assert.ok(docker(["volume", "ls", "-q"]).split("\n").includes(recovered.volume_name));
  const failedAttemptPreview = await restoreCLI("service-volume-preview", []);
  const firstDeletionCapture = failedAttemptPreview.envelope.data.preview.archives.find((a: any) => !beforeArchiveIDs.has(a.archive_id));
  assert.ok(firstDeletionCapture); assert.equal(firstDeletionCapture.integrity, "valid");
  await injectLostReply(`args[0]==='volume' && args[1]==='rm' && args.includes(${JSON.stringify(recovered.volume_name)})`, async () => {
    const lost = await restoreCLI("service-volume-delete", deleteArgs);
    assert.notEqual(lost.code, 0);
    assert.equal(docker(["volume", "ls", "-q", "--filter", `name=^${recovered.volume_name}$`]), "", JSON.stringify(lost.envelope));
  });
  docker(["volume", "create", recovered.volume_name]); volumes.push(recovered.volume_name);
  const replacedDeletion = await restoreCLI("service-volume-delete", deleteArgs);
  assert.notEqual(replacedDeletion.code, 0); assert.match(JSON.stringify(replacedDeletion.envelope), /identity|replaced/);
  assert.ok(docker(["volume", "ls", "-q"]).split("\n").includes(recovered.volume_name));
  docker(["volume", "rm", recovered.volume_name]);
  const deleted = await restoreCLI("service-volume-delete", deleteArgs);
  assert.equal(deleted.code, 0, JSON.stringify(deleted.envelope));
  assert.equal(deleted.envelope.data.deletion.volume.state, "deleted");
  assert.equal(deleted.envelope.data.deletion.volume.name, recovered.volume_name);
  assert.equal(deleted.envelope.data.deletion.recheck.digest, restoredArchive.digest);
  assert.notEqual(deleted.envelope.data.deletion.recheck.operation_id, restoredProofID);
  assert.notEqual(deleted.envelope.data.deletion.recheck.operation_id, firstDeletionCapture.archive_id);
  docker(["volume", "create", recovered.volume_name]);
  assert.deepEqual((await restoreCLI("service-volume-delete", deleteArgs)).envelope.data.deletion, deleted.envelope.data.deletion);
  assert.ok(docker(["volume", "ls", "-q"]).split("\n").includes(recovered.volume_name));
  docker(["volume", "rm", recovered.volume_name]);
  const deletionRecheck = deleted.envelope.data.deletion.recheck;
  const deletionRecheckBytes = readFileSync(deletionRecheck.path);
  try {
    writeFileSync(deletionRecheck.path, "corrupted deletion capture");
    assert.notEqual((await restoreCLI("service-volume-delete", deleteArgs)).code, 0);
  } finally { writeFileSync(deletionRecheck.path, deletionRecheckBytes); }
  const restoredDeletion = await restoreCLI("service-volume-restore", restoreArgs.map(value => value === exportID ? deletionRecheck.operation_id : value === restoreID ? deletionRestoreID : value));
  assert.equal(restoredDeletion.code, 0, JSON.stringify(restoredDeletion.envelope));
  assert.equal(restoredDeletion.envelope.data.restoration.verification.business_checks.status, "passed");
  docker(["rm", restoredDeletion.envelope.data.restoration.container_id]);
  docker(["volume", "rm", restoredDeletion.envelope.data.restoration.volume_name]);
  const missingProofSource = await restoreCLI("service-volume-assess", ["--archive-id", restoredProofID]);
  assert.equal(missingProofSource.code, 0, JSON.stringify(missingProofSource.envelope));
  assert.ok(missingProofSource.envelope.data.assessment.blockers.includes("source_identity_unproven"));
  assert.deepEqual((await restoreCLI("service-volume-export", restoredExportArgs)).envelope.data.archive, restoredArchive);
  writeFileSync(checksFile, JSON.stringify({ checks }));
  const damagedPreview = await restoreCLI("service-volume-preview", []);
  assert.equal(damagedPreview.code, 0, JSON.stringify(damagedPreview.envelope));
  const damaged = damagedPreview.envelope.data.preview;
  assert.equal(damaged.archives.find((a: any) => a.archive_id === exportID).integrity, "unavailable");
  assert.equal(damaged.source.blockers.includes("no_intact_archive"), false);
  const historical = damaged.restorations.find((r: any) => r.restore_id === restoreID);
  assert.equal(historical.business_status, "passed");
  assert.ok(historical.blockers.includes("archive_unavailable"));
  const notStarted = damaged.restorations.find((r: any) => r.restore_id === badRestoreID);
  assert.equal(notStarted.attempt.phase, "not_started");
  assert.equal(notStarted.volume.state, "missing");
  assert.ok(notStarted.blockers.includes("restore_not_completed"));
  assert.deepEqual(damaged.archives.filter((a: any) => [restoredExportID, restoredCompareID].includes(a.archive_id))
    .map((a: any) => [a.source_restore_id, a.integrity]), [[changedRestoreID, "valid"], [changedRestoreID, "valid"]]);
  // Intact restored-volume archives cannot stand in for an original-volume archive.
  writeFileSync(differingRecheck.target_path, "corrupted differing deletion capture");
  writeFileSync(comparedArchive.path, "corrupted remaining original-volume archive");
  writeFileSync(proofExport.envelope.data.archive.path, "corrupted new original-volume proof archive");
  const noOriginal = await restoreCLI("service-volume-preview", []);
  assert.equal(noOriginal.code, 0, JSON.stringify(noOriginal.envelope));
  assert.ok(noOriginal.envelope.data.preview.source.blockers.includes("no_intact_archive"));
  assert.equal(noOriginal.envelope.data.preview.archives.find((a: any) => a.archive_id === restoredExportID).integrity, "valid");
  const rejected = await invoke(); assert.notEqual(rejected.code, 0); assert.match(JSON.stringify(rejected.envelope), /integrity|digest/i);
  assert.equal(docker(["ps", "-aq", "--filter", `label=grounds.volume-export=${exportID}`]), "");
});
