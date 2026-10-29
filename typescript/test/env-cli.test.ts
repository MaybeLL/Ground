import assert from "node:assert/strict";
import {test} from "node:test";
import {writeFileSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {executeEnvironmentCommand,envHelp} from "../src/env-cli.js";
import {temporary} from "./env-test-helpers.js";
test("env CLI trusted-host path does not request SQL identity; runs/logs/down preserve history",async()=>temporary(async(root,workspace)=>{
 let resolutions=0;const result=await executeEnvironmentCommand({positionals:["env","up"],values:{}},workspace,{resolveRepository:async()=>{resolutions++;throw Error("must stay lazy");}}) as any;assert.equal(resolutions,0);assert.equal(result.environment.trust,"trusted_host");
 const file=join(root,"argv.json");writeFileSync(file,JSON.stringify(["sh","-c","echo CLI"]));const ran=await executeEnvironmentCommand({positionals:["env","run",result.environment.id],values:{"argv-file":file}},workspace) as any;assert.equal(ran.run.state,"succeeded");
 const logs=await executeEnvironmentCommand({positionals:["env","logs",ran.run.id],values:{}},workspace) as any;assert.equal(logs.output,"CLI\n");
 await executeEnvironmentCommand({positionals:["env","down",result.environment.id],values:{}},workspace);assert.equal(readFileSync(join(ran.run.directory,"output.log"),"utf8"),"CLI\n");assert.ok(envHelp().includes("没有文件、网络或资源隔离"));
}));
test("CLI refuses unsupported isolation, invalid args and unauthenticated DevRun claims",async()=>temporary(async(_root,workspace)=>{
 await assert.rejects(executeEnvironmentCommand({positionals:["env","up"],values:{"dev-run":"fake"}},workspace));await assert.rejects(executeEnvironmentCommand({positionals:["env","up"],values:{"unknown":true}},workspace));
}));
