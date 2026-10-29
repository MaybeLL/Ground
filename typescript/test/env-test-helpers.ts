import { mkdtempSync,mkdirSync,rmSync,writeFileSync,realpathSync } from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {withRuntimeDirectories} from "../src/runtime-files.js";
import {git} from "../src/env-git.js";
export const temporary=async(fn:(root:string,workspace:string)=>Promise<void>):Promise<void>=>{
 const root=realpathSync(mkdtempSync(join(process.env.GROUNDS_ENV_TEST_ROOT??tmpdir(),"grounds-env-v5-")));const workspace=join(root,"workspace");mkdirSync(workspace);
 let passed=false;
 try{await withRuntimeDirectories({runtimeHome:join(root,"runtime"),directoryRegistryHome:join(root,"registry")},()=>fn(root,workspace));passed=true;}finally{if(passed||!process.env.GROUNDS_ENV_TEST_ROOT)rmSync(root,{recursive:true,force:true});else process.stderr.write(`Retained integration fixture: ${root}\n`);}
};
export const repository=(workspace:string):string=>{
 git(["init","-q",workspace]);git(["config","user.name","Test"],{cwd:workspace});git(["config","user.email","test@example.invalid"],{cwd:workspace});writeFileSync(join(workspace,"README.md"),"original\n");git(["add","."],{cwd:workspace});git(["commit","-qm","input author message"],{cwd:workspace});return git(["rev-parse","HEAD"],{cwd:workspace});
};
