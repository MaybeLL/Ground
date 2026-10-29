import assert from "node:assert/strict";
import {test} from "node:test";
import {existsSync,readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {acquireRouteLease,releaseRouteLease,isRouteLeased} from "../src/env-route-lease.js";
import {inspectTaskGit} from "../src/env-route-exit.js";
import {initializeTaskRepository} from "../src/env-seed.js";
import {git,gitTry} from "../src/env-git.js";
import {temporary,repository} from "./env-test-helpers.js";
test("host occupancy is persistent and external to task data; no Git pointer/refs rewrite",async()=>temporary(async(root,workspace)=>{
 repository(workspace);const before=readFileSync(join(workspace,".git/HEAD"),"utf8");assert.equal(isRouteLeased(join(root,"future")),false);
 const lease=acquireRouteLease({route:workspace,environmentId:"first",runDirectory:join(root,"run"),runId:"run"});assert.equal(isRouteLeased(workspace),true);assert.throws(()=>acquireRouteLease({route:workspace,environmentId:"second",runDirectory:join(root,"other")}));assert.equal(readFileSync(join(workspace,".git/HEAD"),"utf8"),before);releaseRouteLease(lease);assert.equal(isRouteLeased(workspace),false);
}));
test("independent repositories keep exact development history and blind view keeps full tree only",async()=>temporary(async(root,workspace)=>{
 const initial=repository(workspace);writeFileSync(join(workspace,"report.md"),"author report in candidate\n");git(["add","."],{cwd:workspace});git(["commit","-qm","tree author message"],{cwd:workspace});const current=git(["rev-parse","HEAD"],{cwd:workspace});
 const dev=join(root,"dev"),blind=join(root,"blind");initializeTaskRepository({source:workspace,commit:current,destination:dev,branch:"grounds/test/route",scope:"development"});const view=initializeTaskRepository({source:workspace,commit:current,destination:blind,branch:"grounds/test/verify",scope:"blind"});
 assert.equal(git(["rev-parse","HEAD"],{cwd:dev}),current);assert.equal(git(["rev-parse","HEAD^{tree}"],{cwd:blind}),git(["rev-parse","HEAD^{tree}"],{cwd:workspace}));assert.equal(git(["rev-list","--count","HEAD"],{cwd:blind}),"1");assert.equal(gitTry(["cat-file","-t",initial],{cwd:blind}),undefined);assert.equal(readFileSync(join(blind,"report.md"),"utf8"),"author report in candidate\n");assert.equal(existsSync(join(dev,".git/objects/info/alternates")),false);
 git(["config","user.name","Independent"],{cwd:dev});assert.equal(git(["config","user.name"],{cwd:workspace}),"Test");
}));
test("Git inspection retains uncommitted/stash/conflict/detached scenes without normalization",async()=>temporary(async(_root,workspace)=>{
 const initial=repository(workspace);writeFileSync(join(workspace,"README.md"),"dirty\n");assert.ok(inspectTaskGit(workspace,initial).pending.includes("uncommitted_changes"));assert.equal(readFileSync(join(workspace,"README.md"),"utf8"),"dirty\n");git(["stash"],{cwd:workspace});assert.ok(inspectTaskGit(workspace,initial).pending.includes("stash"));git(["checkout","--detach",initial],{cwd:workspace});assert.ok(inspectTaskGit(workspace,initial).pending.includes("detached_head"));
}));

test("SHA-256 task repository preserves object format and hands off exact committed objects",async t=>temporary(async(root,workspace)=>{
 try { git(["init","-q","--object-format=sha256",workspace]); } catch { t.skip("installed Git does not support SHA-256 repositories"); return; }
 git(["config","user.name","Test"],{cwd:workspace});git(["config","user.email","test@example.invalid"],{cwd:workspace});writeFileSync(join(workspace,"source.txt"),"initial\n");git(["add","."],{cwd:workspace});git(["commit","-qm","input"],{cwd:workspace});
 const input=git(["rev-parse","HEAD"],{cwd:workspace}),task=join(root,"sha256-task");
 const seeded=initializeTaskRepository({source:workspace,commit:`sha256:${input}`,destination:task,branch:"grounds/test/sha256",scope:"development"});
 assert.equal(seeded.commit,input);assert.equal(git(["rev-parse","--show-object-format"],{cwd:task}),"sha256");
 writeFileSync(join(task,"result.txt"),"task output\n");git(["add","result.txt"],{cwd:task});git(["commit","-qm","output"],{cwd:task});const output=git(["rev-parse","HEAD"],{cwd:task});
 const {receiveDevelopmentObjects}=await import("../src/development-branch.js"),{newUUIDv7}=await import("../src/identity.js");
 const received=receiveDevelopmentObjects({target_path:workspace,source_path:task,source_commit:`sha256:${output}`,environment_id:newUUIDv7()});
 assert.equal(received.source_commit,`sha256:${output}`);assert.deepEqual(received.parents,[`sha256:${input}`]);assert.equal(git(["show",`${output}:result.txt`],{cwd:workspace}),"task output");assert.equal(git(["rev-parse","HEAD"],{cwd:workspace}),input);
 const blind=join(root,"sha256-blind");initializeTaskRepository({source:workspace,commit:`sha256:${output}`,destination:blind,branch:"grounds/test/blind",scope:"blind"});assert.equal(git(["rev-list","--count","HEAD"],{cwd:blind}),"1");assert.equal(git(["rev-parse","HEAD^{tree}"],{cwd:blind}),received.tree.slice(7));
}));
