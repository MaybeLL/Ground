import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,linkSync,mkdirSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {test} from "node:test";
import {captureWorkspaceFile} from "../src/work/adapters/file-spool.js";
import {parseManagedDeclaration} from "../src/work/domain/managed-delivery.js";

test("a managed claim binds a candidate and distinct files to required slots",()=>{
  const candidate={commit:"1".repeat(40)}, slots=[{key:"report",required:true}];
  const parse=(files:unknown[])=>parseManagedDeclaration(JSON.stringify({candidate,artifacts:[{slot:"report",files}]}),"coding",slots);
  assert.deepEqual(parse([{path:"doc/report",source:"result"}]),{commit:candidate.commit,artifacts:[{slot:"report",files:[{path:"doc/report",source:"result"}]}]});
  for(const files of [[],[{path:"a"},{path:"a/b"}],[{path:"../a"}],[{path:"a",source:"x".repeat(256)}],[{path:"x",source:"/absolute"}]]) assert.equal(parse(files),undefined);
  assert.equal(parseManagedDeclaration(JSON.stringify({candidate}),"working",slots),undefined);
});

test("managed artifacts open regular files beneath their pinned workspace directory",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"grounds-artifact-open-")), work=join(dir,"work"), outside=join(dir,"other");
  try {
    mkdirSync(work);mkdirSync(outside);writeFileSync(join(outside,"secret"),"private");
    symlinkSync(outside,join(work,"redirect"));symlinkSync(join(outside,"secret"),join(work,"leaf"));
    linkSync(join(outside,"secret"),join(work,"hard"));
    execFileSync("mkfifo",[join(work,"pipe")]);
    for(const path of ["../other/secret","redirect/secret","leaf","hard","pipe"]) await assert.rejects(captureWorkspaceFile(work,path));
    writeFileSync(join(work,"file"),Buffer.from([0,128,255]));
    const captured=await captureWorkspaceFile(work,"file");
    try {
      writeFileSync(join(work,"file"),"later bytes");
      const chunks=[];
      for await(const block of captured.source.open()) chunks.push(Buffer.from(block));
      assert.deepEqual(Buffer.concat(chunks),Buffer.from([0,128,255]));
    } finally {await captured.dispose();}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
