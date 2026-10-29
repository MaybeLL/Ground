import assert from "node:assert/strict";
import {test} from "node:test";
import {hostCapabilities,dockerCapabilities,effectiveRequirements,assertCapabilities} from "../src/env-capabilities.js";
test("trusted macOS/Linux host never claims Seatbelt or resource isolation",()=>{
 for(const platform of ["darwin","linux"] as const){assert.equal(hostCapabilities({platform,sandboxExecAvailable:true}).write_confined,false);assert.doesNotThrow(()=>assertCapabilities({requirements:{},capabilities:hostCapabilities()}));for(const requirements of [{network:"none"},{workspace_write:"confined"},{cpu:1},{memory:"1g"},{pids:20}] as const)assert.throws(()=>assertCapabilities({requirements,capabilities:hostCapabilities()}),{code:"ENVIRONMENT_CAPABILITY_UNSUPPORTED"});}
});
test("Docker merges finite per-container defaults before capability checks",()=>{
 const effective=effectiveRequirements({memory:"3g"},"docker");assert.equal(effective.memory,"3g");assert.ok(effective.cpu!>0);assert.ok(effective.pids!>0);assert.doesNotThrow(()=>assertCapabilities({requirements:effective,capabilities:dockerCapabilities()}));assert.throws(()=>assertCapabilities({requirements:effective,capabilities:{...dockerCapabilities(),pids_limit:false}}));assert.deepEqual(effectiveRequirements({},"host"),{});
});
