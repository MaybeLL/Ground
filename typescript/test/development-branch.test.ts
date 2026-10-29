import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DevWorktreeModule } from "../src/dev-worktree.js";
import { receiveDevelopmentObjects, receiveDevelopmentSource, developmentBranchName, createDevelopmentPlan, developmentPath, captureCommittedDevelopment, inspectCandidateSource, retainCandidateSource, type DevelopmentPlan } from "../src/development-branch.js";
import { DomainError } from "../src/errors.js";
import { newUUIDv7 } from "../src/identity.js";
import { resolveBaseline } from "../src/git.js";
import { prepareLocalSync, applyLocalSync, completeLocalSync, abandonLocalSync } from "../src/sync-worktree.js";
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {cwd, encoding:"utf8",stdio:"pipe"}).trim();
function fixture(t: {after(f:()=>void):void}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grounds-branch-test-")));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  git(root,"init","-qb","main"); git(root,"config","user.name","Test");git(root,"config","user.email","test@invalid");
  writeFileSync(join(root,"file.txt"),"base\n");git(root,"add",".");git(root,"commit","-qm","base");
  writeFileSync(join(root,".git","info","exclude"),"/.grounds/\n");
  const base=resolveBaseline(root,"HEAD"), database=newUUIDv7(), repository=newUUIDv7(), workspace=newUUIDv7();
  const identity={format:"grounds.development-branch/v1" as const, workspace_id:workspace, branch:developmentBranchName("branch-test", workspace)};
  const plan:DevelopmentPlan={...identity,database_id:database,repository_id:repository,definition_commit:base,target:{remote:"origin",ref:"refs/heads/main"},path:developmentPath(root,identity),observed_at:new Date().toISOString(),observation:"local_tracking",status:"planned"};
  createDevelopmentPlan(root,plan);
  const manager=new DevWorktreeModule(root,database,newUUIDv7,undefined,join(root,"registry"));
  const input={operation_id:newUUIDv7(),repository_id:repository,issue_revision_id:newUUIDv7(),baseline_oid:base,development_plan:plan};
  return {root,base,identity,plan,manager,input};
}
async function start(f:ReturnType<typeof fixture>) { const value=await f.manager.start(f.input,async id=>({dev_run_id:id,value:id}));assert.equal(value.local_worktree.status,"available");return value.value; }
function commit(cwd:string,file:string,bytes:string|Buffer) {writeFileSync(join(cwd,file),bytes);git(cwd,"add","-A");git(cwd,"commit","-qm",file);}
test("confirmed plan creates no Git worktree until start; checkpoints and merges retain immutable candidates",async t=>{
 const f=fixture(t);assert.equal(existsSync(f.plan.path),false);assert.equal(git(f.root,"for-each-ref","--format=%(refname)",`refs/heads/${f.plan.branch}`),"");assert.deepEqual(createDevelopmentPlan(f.root,f.plan),f.plan);
 const run=await start(f);const path=f.plan.path;commit(path,"one.txt","one\n");commit(path,"two.bin",Buffer.from([0,255,3]));
 git(f.root,"checkout","-qb","side",f.base.split(":")[1]!);commit(f.root,"side.txt","side\n");git(f.root,"checkout","main");git(path,"merge","--no-ff","side","-m","real merge");
 const fixed=captureCommittedDevelopment(path,f.identity,f.base);assert.equal(fixed.source.parents.length,2);assert.match(fixed.artifact.patch.toString(),/GIT binary patch/);assert.equal(f.manager.inspect(run).status,"available");const candidate=newUUIDv7();retainCandidateSource(path,candidate,fixed.source);
 commit(path,"later.txt","later\n");assert.deepEqual(inspectCandidateSource(path,candidate,fixed.source),{status:"present",commit:fixed.source.commit});git(path,"update-ref",`refs/grounds/candidates/${candidate}`,resolveBaseline(path,"HEAD").split(":")[1]!);assert.equal(inspectCandidateSource(path,candidate,fixed.source).status,"inconsistent");assert.throws(()=>retainCandidateSource(path,candidate,fixed.source),(e:unknown)=>e instanceof DomainError && String(e.details.reason).includes("rewritten"));
});
test("dirty files, unfinished Git operations and switched branches are fenced without changing bytes",async t=>{
 const f=fixture(t);const run=await start(f);const path=f.plan.path;commit(path,"committed.txt","yes\n");writeFileSync(join(path,"dirty.bin"),Buffer.from([0,2,3]));assert.throws(()=>captureCommittedDevelopment(path,f.identity,f.base),(e:unknown)=>e instanceof DomainError && String(e.details.reason).includes("uncommitted"));assert.deepEqual(readFileSync(join(path,"dirty.bin")),Buffer.from([0,2,3]));git(path,"add","-A");git(path,"commit","-qm","dirty saved");const merge=resolve(path,git(path,"rev-parse","--git-path","MERGE_HEAD"));writeFileSync(merge,f.base.split(":")[1]!+"\n");assert.throws(()=>captureCommittedDevelopment(path,f.identity,f.base),(e:unknown)=>e instanceof DomainError && String(e.details.reason).includes("unfinished"));rmSync(merge);git(path,"checkout","--detach");assert.equal(f.manager.inspect(run).status,"invalid");
});
test("sync publishes a real two-parent merge and captures only own changes against new logical base",async t=>{
 const f=fixture(t);await start(f);commit(f.plan.path,"own.txt","own\n");const source=resolveBaseline(f.plan.path,"HEAD");commit(f.root,"upstream.txt","upstream\n");const target=resolveBaseline(f.root,"HEAD");const directory=join(f.root,"recovery");prepareLocalSync({cwd:f.plan.path,directory,base:f.base,target,development:f.identity});applyLocalSync(directory);const j=completeLocalSync(directory);assert.equal(j.source_head,source);assert.equal(j.result_commit,resolveBaseline(f.plan.path,"HEAD"));const result=captureCommittedDevelopment(f.plan.path,f.identity,target);assert.deepEqual(result.source.parents,[source,target]);assert.match(result.artifact.patch.toString(),/own.txt/);assert.doesNotMatch(result.artifact.patch.toString(),/upstream.txt/);assert.deepEqual(completeLocalSync(directory).receipt,j.receipt);
});
test("interrupted branch sync abandonment restores original index bytes and preserves edits",async t=>{
 const f=fixture(t);await start(f);commit(f.plan.path,"own.txt","own\n");const original=resolveBaseline(f.plan.path,"HEAD");commit(f.root,"upstream.txt","upstream\n");const target=resolveBaseline(f.root,"HEAD");const directory=join(f.root,"recovery");const index=git(f.plan.path,"rev-parse","--path-format=absolute","--git-path","index"), before=readFileSync(index);prepareLocalSync({cwd:f.plan.path,directory,base:f.base,target,development:f.identity});applyLocalSync(directory);writeFileSync(join(f.plan.path,"own.txt"),"later edits\r\n");const restored=abandonLocalSync(directory);assert.equal(resolveBaseline(f.plan.path,"HEAD"),original);assert.deepEqual(readFileSync(index),before);assert.ok(restored.saved_edits.length);assert.equal(readFileSync(join(f.plan.path,"own.txt"),"utf8"),"own\n");
});
test("branch sync retries the exact journaled merge commit after ref publication interruption",async t=>{
 const f=fixture(t);await start(f);commit(f.plan.path,"own.txt","own\n");commit(f.root,"upstream.txt","upstream\n");const target=resolveBaseline(f.root,"HEAD"),directory=join(f.root,"recovery");prepareLocalSync({cwd:f.plan.path,directory,base:f.base,target,development:f.identity});applyLocalSync(directory);
 assert.throws(()=>completeLocalSync(directory,step=>{if(step==="merge-ref-updated")throw Error("injected process interruption");}),/interruption/);const published=resolveBaseline(f.plan.path,"HEAD");const retried=completeLocalSync(directory);assert.equal(retried.result_commit,published);assert.deepEqual(completeLocalSync(directory).receipt,retried.receipt);
});


test("independent output is retained without branch movement and explicitly adopted with expected HEAD", async t => {
  const f = fixture(t); await start(f);
  const source = join(f.root, "task"); git(f.root, "clone", "--no-local", "--branch", f.identity.branch, f.root, source);
  git(source, "config", "user.name", "Task"); git(source, "config", "user.email", "task@invalid");
  mkdirSync(join(source, ".grounds", "environments"), { recursive: true });
  commit(source, ".grounds/environments/dev.yaml", "backend: docker\n");
  const fixed = resolveBaseline(source, "HEAD"), id = newUUIDv7();
  const input = { target_path: f.plan.path, source_path: source, source_commit: fixed, environment_id: id };
  const marker = join(f.root, "untrusted-hook-executed");
  for (const [key, value] of [["uploadpack.packObjectsHook", `touch '${marker}'`], ["core.worktree", f.root], ["include.path", join(f.root, "external-config")]]) {
    git(source, "config", key, value);
    assert.throws(() => receiveDevelopmentObjects(input), (error: unknown) => error instanceof DomainError && /configuration is unsupported/.test(String(error.details.reason)));
    assert.equal(existsSync(marker), false);
    git(source, "config", "--unset", key);
  }
  const receipt = receiveDevelopmentObjects(input);
  assert.equal(resolveBaseline(f.plan.path, "HEAD"), f.base);
  assert.equal(resolveBaseline(f.plan.path, receipt.ref), fixed);
  assert.deepEqual(receiveDevelopmentObjects(input), receipt);
  const adopt = { target_path: f.plan.path, source_path: source, source_commit: fixed, expected_head: f.base, development: f.identity };
  assert.equal(receiveDevelopmentSource(adopt).commit, fixed);
  assert.equal(captureCommittedDevelopment(f.plan.path, f.identity, f.base, true).artifact.files[0]?.display_path, ".grounds/environments/dev.yaml");
  assert.deepEqual(receiveDevelopmentSource(adopt), { commit: fixed, parents: [f.base] });
  commit(source, "another.txt", "next\n");
  assert.throws(() => receiveDevelopmentObjects({ ...input, source_commit: resolveBaseline(source, "HEAD") }));
  writeFileSync(join(f.plan.path, "unsaved.txt"), "preserve\n");
  assert.throws(() => receiveDevelopmentSource({ ...adopt, source_commit: resolveBaseline(source, "HEAD"), expected_head: fixed }));
  assert.equal(readFileSync(join(f.plan.path, "unsaved.txt"), "utf8"), "preserve\n");
  assert.equal(resolveBaseline(f.plan.path, "HEAD"), fixed);
});

test("branch names reuse route identity; private environment runtime files cannot be captured", async t => {
  const f = fixture(t); await start(f);
  assert.equal(developmentBranchName("Readable Issue: YAML support", f.identity.workspace_id), `grounds/readable-issue-yaml-support/${f.identity.workspace_id}`);
  for (const invalid of ["环境统一", "issue-环境", "---", ""]) assert.throws(() => developmentBranchName(invalid, f.identity.workspace_id), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR");
  assert.notEqual(developmentBranchName("Readable Issue", newUUIDv7()), developmentBranchName("Readable Issue", f.identity.workspace_id));
  const fresh = newUUIDv7();
  assert.throws(() => createDevelopmentPlan(f.root, { ...f.plan, workspace_id: fresh, branch: "grounds/unbound-custom", path: developmentPath(f.root, { ...f.identity, workspace_id: fresh }) }), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR");
  mkdirSync(join(f.plan.path, ".grounds", "environments"), { recursive: true });
  writeFileSync(join(f.plan.path, ".grounds", "environments", "credentials.json"), "private\n");
  git(f.plan.path, "add", "-f", ".grounds/environments/credentials.json"); git(f.plan.path, "commit", "-qm", "invalid runtime");
  assert.throws(() => captureCommittedDevelopment(f.plan.path, f.identity, f.base, true), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR");
});
