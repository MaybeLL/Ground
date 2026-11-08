import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execute } from "../src/cli.js";
import { environmentDefinitionOf, implicitHostDefinition } from "../src/env-definition.js";
import { environmentDown, environmentUp, listEnvironments, saveEnvironment } from "../src/env-environment.js";
import { registerCredentialGrant } from "../src/env-credentials.js";
import { authorizedSharedService, registerSharedService } from "../src/env-services.js";
import { resolveEnvironmentRepository, validateEnvironmentRepository } from "../src/env-repository.js";
import { assertIndependentWorkspace } from "../src/env-route-lease.js";
import { git } from "../src/env-git.js";
import { startRun } from "../src/env-run.js";
import { directoryRegistryRoot } from "../src/runtime-files.js";
import { environmentStoreRoot } from "../src/env-store.js";
import { repository, temporary } from "./env-test-helpers.js";
import { assertContract } from "./schema-fixture.js";

const definition = () => environmentDefinitionOf({ ...implicitHostDefinition(), name: "dev", credentials: [{ name: "model" }] });
const grantFor = (root: string, workspace: string) => {
  const source = join(root, "auth.json");
  writeFileSync(source, JSON.stringify({ account: "test", token: "private-fixture-value" }));
  return { name: "model", repository: resolveEnvironmentRepository(workspace), environment: "dev", source_file: source, account: "test", method: "oauth", access: "model" as const };
};

test("env repository works with no SQL config; linked worktrees share identity, clones do not", async () => temporary(async (root, workspace) => {
  repository(workspace);
  const result = await execute(["env", "repository", "--config", join(root, "missing")], { cwd: workspace }) as any;
  assertContract("environment.schema.json", result);
  const linked = join(root, "linked");
  git(["worktree", "add", "--detach", linked, "HEAD"], { cwd: workspace });
  assert.deepEqual(resolveEnvironmentRepository(linked), result.repository);
  const clone = join(root, "clone");
  git(["clone", "--quiet", workspace, clone]);
  assert.notDeepEqual(resolveEnvironmentRepository(clone), result.repository);
  const alias = join(root, "alias"); symlinkSync(workspace, alias);
  assert.deepEqual(resolveEnvironmentRepository(alias), result.repository);
  assert.equal(existsSync(join(root, "missing")), false);
}));

test("explicit grant admits its local repository and linked worktree, not another clone", async () => temporary(async (root, workspace) => {
  repository(workspace);
  const grant = grantFor(root, workspace);
  await assert.rejects(environmentUp({ workspace, definition: definition() }), { code: "VALIDATION_ERROR" });
  assert.equal(listEnvironments().length, 0);
  registerCredentialGrant(grant);
  const linked = join(root, "linked"); git(["worktree", "add", "--detach", linked, "HEAD"], { cwd: workspace });
  const prepared = await environmentUp({ workspace: linked, definition: definition() });
  assert.deepEqual(prepared.repository, grant.repository);
  assertContract("environment.schema.json#/$defs/environment", prepared);
  environmentDown(prepared.id);
  const clone = join(root, "clone"); git(["clone", "--quiet", workspace, clone]);
  await assert.rejects(environmentUp({ workspace: clone, definition: definition() }), { code: "VALIDATION_ERROR" });
  assert.equal(listEnvironments().length, 1);
}));

test("public CLI prepares and runs credential-bearing env without a ledger", async () => temporary(async (root, workspace) => {
  repository(workspace);
  const grant = grantFor(root, workspace), file = join(root, "grant.json");
  writeFileSync(file, JSON.stringify(grant));
  const invoke = (args: string[]) => execute(["env", ...args, "--config", join(root, "missing")], { cwd: workspace }) as Promise<any>;
  assertContract("environment.schema.json", await invoke(["credential-grant", "--grant-file", file]));
  const declarations = join(workspace, ".grounds", "environments"); mkdirSync(declarations, { recursive: true });
  writeFileSync(join(declarations, "dev.yaml"), "format: grounds.environment-definition/v1\nname: dev\nbackend: host\ncredentials:\n  - name: model\n");
  const up = await invoke(["up", "--definition", "dev"]);
  assert.deepEqual(up.environment.repository, grant.repository);
  const argv = join(root, "argv.json"); writeFileSync(argv, JSON.stringify(["sh", "-c", "test -f \"$GROUNDS_CREDENTIAL_MODEL_FILE\""]));
  const ran = await invoke(["run", up.environment.id, "--argv-file", argv]);
  assert.equal(ran.run.state, "succeeded");
  await invoke(["down", up.environment.id]);
  assert.equal(existsSync(join(root, "missing")), false);
}));

test("direct runner rechecks repository incarnation before publishing a run or spawning", async () => temporary(async (root, workspace) => {
  repository(workspace); registerCredentialGrant(grantFor(root, workspace));
  const prepared = await environmentUp({ workspace, definition: definition() });
  const old = join(root, "old-git"); renameSync(join(workspace, ".git"), old);
  git(["init", "-q", workspace]);
  assert.throws(() => startRun({ environmentId: prepared.id, argv: ["sh", "-c", "touch should-not-exist"] }), { code: "VALIDATION_ERROR" });
  assert.equal(existsSync(join(workspace, "should-not-exist")), false);
  assert.deepEqual(readdirSync(join(prepared.directory, "runs")), []);
  assert.throws(() => validateEnvironmentRepository(prepared.repository!), { code: "VALIDATION_ERROR" });
  rmSync(join(workspace, ".git"), { recursive: true }); renameSync(old, join(workspace, ".git"));
  environmentDown(prepared.id);
}));

test("old DevRun parameters and persisted bindings cannot silently become standalone execution", async () => temporary(async (root, workspace) => {
  await assert.rejects(execute(["env", "up", "--dev-run", "old-run", "--config", join(root, "missing")], { cwd: workspace }), { code: "VALIDATION_ERROR" });
  assert.equal(listEnvironments().length, 0);
  const prepared = await environmentUp({ workspace, definition: implicitHostDefinition() });
  for (const field of ["dev_run_id", "repository_id"]) {
    saveEnvironment({ ...prepared, [field]: "old-ledger-id" });
    assert.throws(() => startRun({ environmentId: prepared.id, argv: ["true"] }), { code: "VALIDATION_ERROR" });
    assert.deepEqual(readdirSync(join(prepared.directory, "runs")), []);
  }
  saveEnvironment(prepared); environmentDown(prepared.id);
}));

test("old and caller-invented grant identities are rejected without rewriting grant files", async () => temporary(async (root, workspace) => {
  repository(workspace);
  const grant = grantFor(root, workspace);
  registerCredentialGrant(grant);
  const path = join(environmentStoreRoot(), "credential-grants.json"), before = readFileSync(path);
  const { repository: identity, ...rest } = grant;
  for (const candidate of [{ ...rest, repository_id: "old-repository" }, { ...grant, repository: { ...identity, inode: "0" } }, { ...grant, repository: { ...identity, extra: true } }]) {
    assert.throws(() => registerCredentialGrant(candidate as any), { code: "VALIDATION_ERROR" });
    assert.deepEqual(readFileSync(path), before);
    assert.throws(() => assertContract("environment.schema.json#/$defs/credentialGrant", { ...rest, repository_id: "old-repository" }));
  }
}));

test("retired managed owner markers and external reservations protect children without mutation", async () => temporary(async (root, workspace) => {
  const child = join(workspace, "child"); mkdirSync(child);
  const marker = join(root, "owner.json"); writeFileSync(marker, "broken");
  await assert.rejects(environmentUp({ workspace: child, definition: implicitHostDefinition() }), { code: "STATE_CONFLICT" });
  assert.equal(readFileSync(marker, "utf8"), "broken");
  rmSync(marker); symlinkSync(join(root, "absent"), marker);
  assert.throws(() => assertIndependentWorkspace(child), { code: "STATE_CONFLICT" });
  rmSync(marker);
  mkdirSync(directoryRegistryRoot(), { recursive: true });
  const registry = join(directoryRegistryRoot(), "workspace-registry.json");
  for (const bytes of ["{broken", JSON.stringify({ old: { directory: workspace } })]) {
    writeFileSync(registry, bytes);
    assert.throws(() => assertIndependentWorkspace(child), { code: "STATE_CONFLICT" });
    assert.equal(readFileSync(registry, "utf8"), bytes);
  }
  assert.equal(listEnvironments().length, 0);
}));

test("damaged Git pointers and dangling symlinks protect child paths", async () => temporary(async (root, workspace) => {
  const child = join(workspace, "child"); mkdirSync(child);
  const dotgit = join(workspace, ".git");
  writeFileSync(dotgit, "gitdir: missing-ledger");
  await assert.rejects(environmentUp({ workspace: child, definition: implicitHostDefinition() }), { code: "STATE_CONFLICT" });
  assert.equal(readFileSync(dotgit, "utf8"), "gitdir: missing-ledger");
  rmSync(dotgit); symlinkSync(join(root, "missing-ledger"), dotgit);
  await assert.rejects(environmentUp({ workspace: child, definition: implicitHostDefinition() }), { code: "STATE_CONFLICT" });
  assert.equal(listEnvironments().length, 0);
}));

test("reservation appearing after preparation blocks direct execution before spawning", async () => temporary(async (root, workspace) => {
  const prepared = await environmentUp({ workspace, definition: implicitHostDefinition() });
  const marker = join(root, "owner.json"); writeFileSync(marker, "broken");
  assert.throws(() => startRun({ environmentId: prepared.id, argv: ["true"] }), { code: "STATE_CONFLICT" });
  assert.deepEqual(readdirSync(join(prepared.directory, "runs")), []);
  rmSync(marker); environmentDown(prepared.id);
}));

test("shared service authorization requires exact local repository, environment and kind without Docker", async () => temporary(async (root, workspace) => {
  repository(workspace);
  const identity = resolveEnvironmentRepository(workspace);
  const shared = { name: "db", kind: "postgres" as const, container_id: "a".repeat(64), network_id: "b".repeat(64), host: "database", port: 5432, repository: identity, environment: "dev" };
  assert.throws(() => authorizedSharedService("db", "postgres", identity, "dev"), { code: "VALIDATION_ERROR" });
  assertContract("environment.schema.json#/$defs/sharedService", shared);
  registerSharedService(shared);
  assert.deepEqual(authorizedSharedService("db", "postgres", identity, "dev"), shared);
  const clone = join(root, "clone"); git(["clone", "--quiet", workspace, clone]);
  assert.throws(() => authorizedSharedService("db", "postgres", resolveEnvironmentRepository(clone), "dev"), { code: "VALIDATION_ERROR" });
  assert.throws(() => authorizedSharedService("db", "postgres", identity, "production"), { code: "VALIDATION_ERROR" });
  assert.throws(() => authorizedSharedService("db", "mysql", identity, "dev"), { code: "VALIDATION_ERROR" });
  assert.throws(() => registerSharedService({ ...shared, repository_id: "old" } as any), { code: "VALIDATION_ERROR" });
}));

test("persisted host scope schemas accept boot-relative and legacy observations",()=>{
  const scope={marker:"f".repeat(64),startedAtMs:123456};
  const check=(value:unknown)=>assertContract("environment.schema.json#/$defs/run/properties/host_scope",value);
  check(scope);
  check({...scope,linuxBoot:{id:"c9cf7e5b-f44a-48ce-b998-01edda281af1",uptimeMs:1000,namespaces:"time:[1]/pid:[2]/user:[3]/mnt:[4]"}});
  assert.throws(()=>check({...scope,linuxBoot:{uptimeMs:1000}}));
});
