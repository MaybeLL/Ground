import {execFile,spawn} from "node:child_process";
import {createRequire} from "node:module";
import {dirname,isAbsolute,join,relative,resolve} from "node:path";
import {existsSync} from "node:fs";
import {readFile,realpath,stat} from "node:fs/promises";
import {promisify} from "node:util";
import {parse,type ParseError} from "jsonc-parser";
import {dataLayout} from "../../../data-layout.js";
import {atomicPrivateWrite,privateDirectory,safeRead,withRuntimeLock} from "../../../runtime-files.js";
import {MaterialWorkspaces} from "../git/material-workspaces.js";
import {checkIsolation,pinnedConfig} from "./config.js";
import type {BuildSource,BuildResult} from "../../ports/environment-build.js";

const exec=promisify(execFile);
const cli=createRequire(import.meta.url).resolve("@devcontainers/cli/devcontainer.js");
const label="dev.grounds.environment-build";
const inside=(root:string,path:string)=>path===root || path.startsWith(root+"/");

async function sourcePath(root:string,base:string,value:unknown,directory:boolean) {
  if (typeof value!=="string" || !value || isAbsolute(value) || value.includes("${") || value.includes("\0")) throw Error("expected a path within the frozen repository");
  const path=resolve(base,value);
  if (!inside(root,path)) throw Error("build path escapes its frozen repository");
  const resolved=await realpath(path);
  if (!inside(root,resolved)) throw Error("build symlink escapes its frozen repository");
  const info=await stat(resolved);
  if (!(directory ? info.isDirectory() : info.isFile())) throw Error("incorrect build input type");
  return resolved;
}

async function readText(path:string) {
  if ((await stat(path)).size>1024*1024) throw Error("devcontainer config or lockfile exceeds 1 MiB");
  return new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(await readFile(path));
}

async function runBuild(args:string[],lock:number) {
  const child=spawn(cli,args,{stdio:["ignore","ignore","ignore",lock]});
  await new Promise<void>((ok,no)=>{
    child.once("error",no);
    child.once("close",code=>code===0 ? ok() : no(Error("devcontainer build failed")));
  });
}

export class DevcontainerBuilds {
  constructor(private readonly ledgerId:()=>Promise<string>) {}

  async build(id:string,input:BuildSource):Promise<BuildResult> {
    const ledger=await this.ledgerId();
    const owner=ledger+"-"+id, image="grounds-environment:"+owner;
    const root=privateDirectory(join(dataLayout().runtime,"environment-builds",ledger,id));
    return withRuntimeLock(root,"build",async lock=>{
      let planned;
      try {
        const workspace=await new MaterialWorkspaces().prepare(ledger,id,[{name:"source",repository:input.repository,commit:input.commit}]);
        planned=await this.plan(workspace.materials[0]!.path,input.path,root,image,owner);
      } catch (error) {return {status:"invalid",reason:error instanceof Error ? error.message : "could not read frozen environment sources"};}
      try {
        const args=["image","ls","--no-trunc","--filter","reference="+image,"--format","{{.ID}}"];
        const receipt=join(root,"image-id");
        const recorded=existsSync(receipt) ? safeRead(receipt,128).toString() : undefined;
        if (recorded!==undefined && !/^sha256:[a-f0-9]{64}$/.test(recorded)) return {status:"conflict",reason:"invalid frozen build receipt"};
        const existing=recorded ?? (await exec("docker",args)).stdout.trim();
        if (!existing) {
          atomicPrivateWrite(join(root,"devcontainer.json"),JSON.stringify(planned.build));
          if (planned.lockfile!==undefined) atomicPrivateWrite(join(root,"devcontainer-lock.json"),planned.lockfile);
          await runBuild(["build","--workspace-folder",planned.context,"--config",join(root,"devcontainer.json"),"--image-name",image,
            "--oci-auth-hardening",planned.lockfile===undefined ? "--no-lockfile" : "--frozen-lockfile"],lock);
        }
        const {stdout}=await exec("docker",["image","inspect","--format",'{{.Id}} {{index .Config.Labels "'+label+'"}}',recorded ?? image]);
        const [imageDigest,actualOwner]=stdout.trim().split(" ");
        if (!imageDigest || !/^sha256:[a-f0-9]{64}$/.test(imageDigest) || actualOwner!==owner) return {status:"conflict",reason:"image does not carry the reserved build identity"};
        if (recorded!==undefined && recorded!==imageDigest) return {status:"conflict",reason:"image differs from the original build receipt"};
        if (recorded===undefined) atomicPrivateWrite(receipt,imageDigest);
        return {status:"built",image:{config:planned.config,source:planned.source,imageDigest,...(planned.lockfile!==undefined ? {lockfile:planned.lockfile} : {})}};
      } catch {return {status:"unavailable",reason:"could not build or verify the owned devcontainer image; retry the original operation"};}
    },120000);
  }

  private async plan(repo:string,path:string,root:string,image:string,owner:string) {
    const original=await sourcePath(repo,repo,path,false);
    const source=await readText(original),errors:ParseError[]=[];
    const config=parse(source.replace(/^\uFEFF/,""),errors,{allowTrailingComma:true});
    if (errors.length || !config || typeof config!=="object" || Array.isArray(config)) throw Error("invalid devcontainer configuration");
    checkIsolation(config);
    if (config.dockerComposeFile) throw Error("this environment builder requires a single image configuration");
    const spec=config.build ?? (config.dockerFile ? {dockerfile:config.dockerFile,context:config.context} : undefined);
    if (spec && (typeof spec!=="object" || Object.keys(spec).some(key=>!["dockerfile","context","args","target"].includes(key)))) throw Error("unsupported devcontainer build setting");
    const base=dirname(original);
    const context=await sourcePath(repo,base,spec?.context ?? ".",true);
    let dockerfile;
    if (spec) {
      if (config.image) throw Error("select a Dockerfile or an image");
      dockerfile=await sourcePath(repo,base,spec.dockerfile,false);
    } else {
      if (typeof config.image!=="string" || !/^[a-z0-9][a-z0-9./_:@-]*$/i.test(config.image)) throw Error("missing or invalid base image");
      dockerfile=join(root,"Dockerfile");
      atomicPrivateWrite(dockerfile,"FROM "+config.image+"\n");
    }
    if (spec?.args && (Array.isArray(spec.args) || typeof spec.args!=="object" || Object.entries(spec.args).some(([key,v])=>!/^\w+$/.test(key) || typeof v!=="string" || v.includes("${")))) throw Error("expected literal Docker build arguments");
    if (spec?.target && (typeof spec.target!=="string" || !/^[a-z0-9_.-]+$/i.test(spec.target))) throw Error("invalid Dockerfile stage");
    const {build:ignored,dockerFile,context:oldContext,features,...launch}=config;
    const configText=JSON.stringify({...launch,image});
    pinnedConfig(configText,"sha256:"+"0".repeat(64));
    let lockfile:string|undefined;
    const lockname=path.endsWith("/.devcontainer.json") || path===".devcontainer.json" ? ".devcontainer-lock.json" : "devcontainer-lock.json";
    try {lockfile=await readText(await sourcePath(repo,base,lockname,false));} catch(error) {if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
    if (lockfile!==undefined) JSON.parse(lockfile);
    const selected:Record<string,unknown>={};
    if (features!==undefined && (!features || typeof features!=="object" || Array.isArray(features))) throw Error("invalid feature list");
    for (const [name,options] of Object.entries(features ?? {})) {
      if (JSON.stringify(options).includes("${")) throw Error("feature settings require literal build inputs");
      if (name.startsWith("./") || name.startsWith("../")) {
        const feature=await sourcePath(repo,base,name,true);
        selected[relative(root,feature)]=options;
      } else {
        if (!/^[a-z0-9.-]+\/[a-z0-9._/:-]+$/.test(name) || lockfile===undefined) throw Error("remote features require a frozen lockfile");
        selected[name]=options;
      }
    }
    return {source,config:configText,lockfile,context,build:{build:{dockerfile:relative(root,dockerfile),context:relative(root,context),
      ...(spec?.args ? {args:spec.args} : {}),...(spec?.target ? {target:spec.target} : {}),options:["--label",label+"="+owner]},
      ...(Object.keys(selected).length ? {features:selected} : {})}};
  }
}
