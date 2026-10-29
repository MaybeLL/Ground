import assert from "node:assert/strict";
import {test} from "node:test";
import {existsSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {credentialOccupancy,registerCredentialGrant} from "../src/env-credentials.js";
import {environmentUp,environmentDown,environmentPrivateDirectory,readEnvironment} from "../src/env-environment.js";
import {environmentDefinitionOf,implicitHostDefinition} from "../src/env-definition.js";
import {startRun} from "../src/env-run.js";
import {temporary} from "./env-test-helpers.js";
test("credentials require matching resolved task identity and host grant; values never enter frozen snapshot",async()=>temporary(async(root,workspace)=>{
 const source=join(root,"auth.json");writeFileSync(source,JSON.stringify({account:"test",method:"oauth",token:"secret-token-one"}));
 const definition=environmentDefinitionOf({...implicitHostDefinition(),name:"dev",credentials:[{name:"model",path:"model/auth.json"}]});
 await assert.rejects(environmentUp({workspace,definition,taskRepositoryId:"repo",resolvedRepositoryId:"repo"}));
 registerCredentialGrant({name:"model",repository_id:"repo",environment:"dev",source_file:source,account:"test",method:"oauth",access:"model",writeback:true,identity_fields:["account","method"]});
 await assert.rejects(environmentUp({workspace,definition,taskRepositoryId:"repo",resolvedRepositoryId:"another"}));
 const env=await environmentUp({workspace,definition,taskRepositoryId:"repo",resolvedRepositoryId:"repo"});
 assert.equal(credentialOccupancy({sourceFile:source}).length,1);
 assert.ok(!JSON.stringify(env).includes("secret-token-one"));
 const run=await startRun({environmentId:env.id,argv:["sh","-c",'cat "$GROUNDS_CREDENTIAL_MODEL_FILE"; echo stderr >&2']}).done;
 assert.ok(!readFileSync(join(run.directory,"output.log"),"utf8").includes("secret-token-one"));assert.equal(readFileSync(join(run.directory,"stderr.log"),"utf8"),"stderr\n");
 environmentDown(env.id);assert.ok(existsSync(source));assert.ok(!existsSync(environmentPrivateDirectory(env.id)));assert.equal(credentialOccupancy({sourceFile:source}).length,0);
}));
test("two refreshed copies CAS against same source version; stale return cannot overwrite newer source or prevent cleanup",async()=>temporary(async(root,workspace)=>{
 const source=join(root,"auth.json");writeFileSync(source,JSON.stringify({account:"test",method:"oauth",token:"original"}));
 registerCredentialGrant({name:"model",repository_id:"repo",environment:"dev",source_file:source,account:"test",method:"oauth",access:"model",writeback:true,identity_fields:["account","method"]});
 const definition=environmentDefinitionOf({...implicitHostDefinition(),name:"dev",credentials:[{name:"model"}]});
 const prepare=()=>environmentUp({workspace,definition,taskRepositoryId:"repo",resolvedRepositoryId:"repo"});const a=await prepare(),b=await prepare();
 writeFileSync(join(environmentPrivateDirectory(a.id),"credentials/model"),JSON.stringify({account:"test",method:"oauth",token:"newer"}));writeFileSync(join(environmentPrivateDirectory(b.id),"credentials/model"),JSON.stringify({account:"test",method:"oauth",token:"stale"}));
 environmentDown(a.id);environmentDown(b.id);assert.equal(JSON.parse(readFileSync(source,"utf8")).token,"newer");assert.equal(readEnvironment(a.id).credentials[0].sync,"updated");assert.equal(readEnvironment(b.id).credentials[0].sync,"conflict");assert.equal(readEnvironment(b.id).state,"released");assert.equal(credentialOccupancy({sourceFile:source}).length,0);
}));

test("credential grants reject hidden values and mismatched declared account before persistence",async()=>temporary(async(root)=>{
 const source=join(root,"auth.json");writeFileSync(source,JSON.stringify({account:"test",method:"oauth",token:"private-secret"}));
 const grant={name:"model",repository_id:"repo",environment:"dev",source_file:source,account:"test",method:"oauth",access:"model" as const,writeback:true,identity_fields:["account","method"]};
 assert.throws(()=>registerCredentialGrant({...grant,secret:"must-never-be-stored"} as any));assert.throws(()=>registerCredentialGrant({...grant,account:"other"}));assert.throws(()=>registerCredentialGrant({...grant,method:"other"}));assert.doesNotThrow(()=>registerCredentialGrant(grant));
}));
