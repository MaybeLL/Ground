import { cpSync, mkdtempSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { git } from "../src/env-git.js";
import { CodeWorkspaces } from "../src/code-workspace.js";
import { newUUIDv7 } from "../src/identity.js";
import { LedgerFixture, testAgent } from "./fixture.js";
import { SQLStore } from "../src/sql-store.js";

export async function codeWorkspaceFixture(t: TestContext, seedDirectory?: string, store?: SQLStore) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-code-workspace-")));
  const ledgerPath = join(root, "ledger.db");
  const ledger = await LedgerFixture.createWithStore(store ?? SQLStore.sqlite(ledgerPath));
  t.after(async () => { await ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const remote = join(root, "remote.git"), writer = join(root, "writer"), dataRoot = join(root, "data");
  mkdirSync(writer);
  git(["init", "--bare", "--initial-branch=main", remote]);
  git(["init", "--initial-branch=main", writer]);
  git(["config", "user.name", "Fixture"], { cwd: writer });
  git(["config", "user.email", "fixture@example.invalid"], { cwd: writer });
  git(["remote", "add", "origin", remote], { cwd: writer });
  if (seedDirectory) {
    cpSync(seedDirectory, writer, { recursive: true });
    git(["add", "."], { cwd: writer });
  }
  const publish = (text: string) => {
    writeFileSync(join(writer, "service.txt"), text);
    git(["add", "service.txt"], { cwd: writer });
    git(["commit", "-qm", "fixture change"], { cwd: writer });
    git(["push", "-q", "origin", "HEAD"], { cwd: writer });
    return `sha1:${git(["rev-parse", "HEAD"], { cwd: writer })}`;
  };
  const firstCommit = publish("first version\n"), hostId = newUUIDv7();
  const service = new CodeWorkspaces(ledger.store, { repositorySource: () => remote });
  const configurationId = newUUIDv7();
  await service.saveConfiguration({ configuration_id: configurationId, expected_version: 0, attribution: testAgent,
    configuration: { name: "Services", repositories: [{ repository_id: ledger.repository.repository_id, alias: "orders", revision: { branch: "main" } }] } });
  const create = (configurationVersion = 1) => service.createInstance({ operation_id: newUUIDv7(), configuration_id: configurationId,
    configuration_version: configurationVersion, issue_id: ledger.issue.issue_id, issue_version: 1, host_id: hostId, attribution: testAgent });
  const failAfterGit = (command: string) => {
    const directory = join(root, "git-fault");
    mkdirSync(directory, { recursive: true });
    const originalPath = process.env.PATH;
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(directory, "git"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nconst args=process.argv.slice(2);\nconst result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});\nprocess.exit(result.status === 0 && args.includes(${JSON.stringify(command)}) ? 97 : (result.status ?? 98));\n`, { mode: 0o700 });
    process.env.PATH = directory + ":" + originalPath;
    const restore = () => { process.env.PATH = originalPath; };
    t.after(restore);
    return restore;
  };
  return { root, remote, writer, dataRoot, ledger, ledgerPath, service, create, publish, firstCommit, hostId, configurationId, failAfterGit };
}
