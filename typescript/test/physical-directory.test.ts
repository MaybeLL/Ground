import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { assertPhysicalDirectoryFree, physicalIdentity, physicalClaims, reservePhysicalDirectory, releasePhysicalDirectory, type PhysicalDirectoryClaim } from "../src/physical-directory.js";
import { privateDirectory, withRuntimeLock } from "../src/runtime-files.js";
function fixture(t: any) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "grounds-physical-"))), directory = privateDirectory(join(base, "source")), registry = privateDirectory(join(base, "registry"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const claim: PhysicalDirectoryClaim = {kind:"environment", owner:join(base,"root-a"),id:"lease-a",directory,identity:physicalIdentity(directory)};
  const locked = <T>(fn:()=>Promise<T>)=>withRuntimeLock(registry,"directory-registry",fn);
  return {base,directory,registry,claim,locked};
}
test("idle ownership persists without its controller or root; nested paths and foreign releases stay fenced", async t => {
  const x=fixture(t);
  await x.locked(async()=>{
    reservePhysicalDirectory(x.registry,x.claim);
    reservePhysicalDirectory(x.registry,x.claim);
    assert.equal(Object.keys(physicalClaims(x.registry)).length,1);
    assert.throws(()=>assertPhysicalDirectoryFree(x.directory,x.registry));
    assert.throws(()=>assertPhysicalDirectoryFree(join(x.directory,"future-child"),x.registry));
    assert.throws(()=>assertPhysicalDirectoryFree(x.base,x.registry));
    assert.throws(()=>reservePhysicalDirectory(x.registry,{...x.claim,owner:join(x.base,"root-b")}));
    assert.throws(()=>releasePhysicalDirectory(x.registry,{...x.claim,identity:"0:0"}));
    assert.equal(Object.keys(physicalClaims(x.registry)).length,1);
    releasePhysicalDirectory(x.registry,x.claim);
    assertPhysicalDirectoryFree(x.directory,x.registry);
  });
});
test("sync intents remain unavailable to offline owners until explicit terminal recovery", async t => {
  const x=fixture(t), sync={...x.claim,kind:"sync" as const,owner:"database:run",id:"sync-op"};
  await x.locked(async()=>{
    reservePhysicalDirectory(x.registry,sync);
    assert.throws(()=>reservePhysicalDirectory(x.registry,x.claim));
    releasePhysicalDirectory(x.registry,sync);
    reservePhysicalDirectory(x.registry,x.claim);
    // Verification copies immutable Git objects, so an idle development lease
    // does not by itself forbid a separate verification snapshot.
    assertPhysicalDirectoryFree(x.directory,x.registry,undefined,["sync"]);
  });
});
test("directory replacement, symlink aliases and malformed registries cannot silently reclaim ownership", async t => {
  const x=fixture(t);
  await x.locked(async()=>{
    reservePhysicalDirectory(x.registry,x.claim);
    const alias=join(x.base,"alias");symlinkSync(x.directory,alias);
    assert.throws(()=>reservePhysicalDirectory(x.registry,{...x.claim,directory:alias}));
    assert.equal(physicalIdentity(realpathSync(alias)),x.claim.identity);
    assert.throws(()=>reservePhysicalDirectory(x.registry,{...x.claim,identity:"0:0"}));
    writeFileSync(join(x.registry,"physical-directory-registry.json"),'{"bad":{}}');
    assert.throws(()=>assertPhysicalDirectoryFree(x.directory,x.registry));
  });
});
test("independent processes and environment roots have exactly one winner; process exit does not release it", async t => {
  const x=fixture(t);
  function child(owner: string): Promise<number | null> {
    const script=`import {reservePhysicalDirectory} from ${JSON.stringify(new URL('../src/physical-directory.ts',import.meta.url).href)};
      import {withRuntimeLock} from ${JSON.stringify(new URL('../src/runtime-files.ts',import.meta.url).href)};
      try { await withRuntimeLock(${JSON.stringify(x.registry)},'directory-registry',async()=>reservePhysicalDirectory(${JSON.stringify(x.registry)},${JSON.stringify({...x.claim,owner})})); }
      catch(e) { if(e.code!=='STATE_CONFLICT')throw e; process.exitCode=10; }`;
    const p=spawn(process.execPath,['--import','tsx','--input-type=module','--eval',script],{stdio:['ignore','pipe','pipe']});
    let errors='';p.stderr.on('data',b=>errors+=b);
    return new Promise((yes,no)=>{p.on('error',no);p.on('close',code=>{if(code!==0&&code!==10)no(new Error(errors));else yes(code);});});
  }
  const result=await Promise.all([child('root-a'),child('root-b')]);
  assert.deepEqual(result.sort(),[0,10]);
  assert.equal(await child('root-c'),10);
  await x.locked(async()=>{
    const claims=Object.values(physicalClaims(x.registry));assert.equal(claims.length,1);
    releasePhysicalDirectory(x.registry,claims[0]!);
  });
  assert.equal(await child('root-c'),0);
});
