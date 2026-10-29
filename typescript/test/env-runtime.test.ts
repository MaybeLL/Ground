import assert from "node:assert/strict";
import {test} from "node:test";
import {existsSync,readFileSync,writeFileSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {materializeBase} from "../src/env-base.js";
import {environmentDefinitionOf,implicitHostDefinition} from "../src/env-definition.js";
import {environmentUp,environmentDown,readEnvironment,environmentPrivateDirectory} from "../src/env-environment.js";
import {startRun,cancelRun,reconcileRun,readRun} from "../src/env-run.js";
import {isRouteLeased} from "../src/env-route-lease.js";
import {temporary,repository} from "./env-test-helpers.js";
test("trusted setup cache and failures retain diagnostics without successful half-base",async()=>temporary(async(root)=>{
 const definition=environmentDefinitionOf({...implicitHostDefinition(),base:{setup:[["sh","-c",'echo once >> "$GROUNDS_BASE_CACHE/count"']]}});
 const a=await materializeBase(definition),b=await materializeBase(definition);assert.equal(b.reused,true);assert.equal(readFileSync(join(a.cache,"count"),"utf8"),"once\n");
 await assert.rejects(materializeBase(environmentDefinitionOf({...implicitHostDefinition(),base:{setup:[["sh","-c","exit 7"]]}})),{code:"ENVIRONMENT_SETUP_FAILED"});
 assert.ok(readdirSync(join(root,"runtime/environments/bases")).some(name=>name.includes(".failed-")));
}));
test("host execution preserves normal Git and caller workspace; summary logs and explicit output survive down",async()=>temporary(async(_root,workspace)=>{
 repository(workspace);const before=readFileSync(join(workspace,".git/HEAD"),"utf8");
 const env=await environmentUp({workspace,definition:implicitHostDefinition()});
 const started=startRun({environmentId:env.id,argv:["sh","-c",'echo observed; echo report > "$GROUNDS_OUTPUT_DIRECTORY/report.txt"'],artifacts:["report.txt"]});
 assert.equal(isRouteLeased(workspace),true);const result=await started.done;assert.equal(result.state,"succeeded");assert.equal(result.termination,"confirmed");assert.equal(result.write_boundary,"not_enforced");assert.equal(readFileSync(join(workspace,".git/HEAD"),"utf8"),before);
 assert.equal(isRouteLeased(workspace),true);assert.equal(result.cleanup,"pending");environmentDown(env.id);assert.equal(isRouteLeased(workspace),false);assert.ok(existsSync(workspace));assert.ok(existsSync(join(result.directory,"output.log")));assert.equal(readFileSync(join(env.directory,"artifacts/report.txt"),"utf8"),"report\n");assert.equal(readEnvironment(env.id).state,"released");environmentDown(env.id);
}));
test("host cancel and timeout preserve changes without replaying command",async()=>temporary(async(_root,workspace)=>{
 repository(workspace);const env=await environmentUp({workspace,definition:implicitHostDefinition()});
 const run=startRun({environmentId:env.id,argv:["sh","-c","echo first >> count; sleep 20"],timeoutMs:100});
 const began=Date.now();const result=await run.done;assert.ok(Date.now()-began<5000,"timeout must terminate the original sleep rather than waiting for it to finish");assert.equal(result.state,"timed_out");assert.equal(result.termination,"confirmed");assert.equal(readFileSync(join(workspace,"count"),"utf8"),"first\n");
 cancelRun(result.id);reconcileRun(result.id);assert.equal(readFileSync(join(workspace,"count"),"utf8"),"first\n");environmentDown(env.id);assert.ok(existsSync(join(workspace,"count")));
}));
test("declared missing artifact blocks down and keeps private files for retry",async()=>temporary(async(_root,workspace)=>{
 const env=await environmentUp({workspace,definition:environmentDefinitionOf({...implicitHostDefinition(),artifacts:["report.json"]})});
 await startRun({environmentId:env.id,argv:["true"]}).done;assert.throws(()=>environmentDown(env.id));assert.ok(existsSync(environmentPrivateDirectory(env.id)));writeFileSync(join(environmentPrivateDirectory(env.id),"out/report.json"),"{}");environmentDown(env.id);assert.equal(readEnvironment(env.id).state,"released");
}));


test("host occupancy protects missing artifacts across phases and competing prepared environments",async()=>temporary(async(_root,workspace)=>{
 repository(workspace);
 const owner=await environmentUp({workspace,definition:environmentDefinitionOf({...implicitHostDefinition(),artifacts:["report.json"]})});
 // A second environment may have been prepared before the first command claimed the workspace.
 const competitor=await environmentUp({workspace,definition:implicitHostDefinition()});
 const first=await startRun({environmentId:owner.id,argv:["true"]}).done;
 assert.equal(first.termination,"confirmed");assert.equal(first.cleanup,"pending");assert.equal(isRouteLeased(workspace),true);
 assert.throws(()=>environmentDown(owner.id));assert.equal(readEnvironment(owner.id).cleanup?.state,"blocked");
 assert.ok(existsSync(environmentPrivateDirectory(owner.id)));assert.equal(isRouteLeased(workspace),true);
 await assert.rejects(environmentUp({workspace,definition:implicitHostDefinition()}));
 assert.throws(()=>startRun({environmentId:competitor.id,argv:["sh","-c","echo intrusion > competitor-ran"]}));
 assert.equal(existsSync(join(workspace,"competitor-ran")),false);
 for(let n=0;n<2;n++){reconcileRun(first.id);cancelRun(first.id);assert.equal(isRouteLeased(workspace),true);assert.throws(()=>environmentDown(owner.id));}
 // The same instance may run a later phase to produce its required output.
 const next=await startRun({environmentId:owner.id,argv:["sh","-c",'echo "{}" > "$GROUNDS_OUTPUT_DIRECTORY/report.json"']}).done;
 assert.equal(next.state,"succeeded");assert.equal(next.termination,"confirmed");assert.equal(isRouteLeased(workspace),true);
 const persistedLease=readFileSync(first.lease!.file,"utf8");
 environmentDown(owner.id);assert.equal(isRouteLeased(workspace),false);
 // Reconstruct the durable checkpoint after release was saved but before occupancy unlink.
 writeFileSync(first.lease!.file,persistedLease,{flag:"wx"});
 writeFileSync(join(first.directory,"run.json"),JSON.stringify({...readRun(first.id),cleanup:"pending"}));
 environmentDown(owner.id);environmentDown(owner.id);assert.equal(isRouteLeased(workspace),false);
 assert.equal(readRun(first.id).cleanup,"complete");
 assert.equal(readFileSync(join(owner.directory,"artifacts/report.json"),"utf8"),"{}\n");
 const allowed=await startRun({environmentId:competitor.id,argv:["true"]}).done;assert.equal(allowed.state,"succeeded");
 environmentDown(owner.id);assert.equal(isRouteLeased(workspace),true,"replaying old down must preserve the subsequent owner");environmentDown(competitor.id);
}));
