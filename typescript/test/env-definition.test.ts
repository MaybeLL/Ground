import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdirSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {implicitHostDefinition,environmentDefinitionOf,readEnvironmentDefinitions,selectEnvironmentDefinition} from "../src/env-definition.js";
import {temporary} from "./env-test-helpers.js";
test("no definition selects trusted host; environment definitions are deterministic frozen input",async()=>temporary(async(_root,workspace)=>{
 assert.equal(selectEnvironmentDefinition(readEnvironmentDefinitions(workspace)).backend,"host");assert.deepEqual(implicitHostDefinition().requirements,{});
 mkdirSync(join(workspace,".grounds/environments"),{recursive:true});writeFileSync(join(workspace,".grounds/environments/dev.yaml"),'format: grounds.environment-definition/v1\nname: dev\nbackend: host\ntools: [git]\n');
 const first=selectEnvironmentDefinition(readEnvironmentDefinitions(workspace));assert.deepEqual(first.tools,["git"]);assert.equal(environmentDefinitionOf(first).digest,first.digest);
}));
test("multi-repository, foreign paths, unknown fields and invalid service declarations reject",()=>{
 const original=implicitHostDefinition();
 for(const repositories of [[],[{name:"a",path:"."},{name:"b",path:"../other"}],[{name:"a",path:"docs"}]])assert.throws(()=>environmentDefinitionOf({...original,repositories}));
 assert.throws(()=>environmentDefinitionOf({...original,unexpected:true} as any));
 assert.throws(()=>environmentDefinitionOf({...original,services:[{name:"db",kind:"redis"}]} as any));
});
test("Docker needs explicit image recipe and supports private/shared service and credential references",()=>{
 assert.throws(()=>environmentDefinitionOf({...implicitHostDefinition(),backend:"docker"}));
 const definition=environmentDefinitionOf({...implicitHostDefinition(),backend:"docker",base:{image:{dockerfile:"Dockerfile",context:"."},setup:[["true"]]},services:[{name:"db",kind:"postgres",shared:"test-db"}],credentials:[{name:"codex",path:"codex/auth.json"}],artifacts:["report.json"]});
 assert.equal(definition.services[0].shared,"test-db");assert.equal(definition.credentials[0].path,"codex/auth.json");
});
