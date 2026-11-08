import {execFile,spawn} from "node:child_process";
import {createRequire} from "node:module";
import {dirname,isAbsolute,join,relative,resolve} from "node:path";
import {existsSync} from "node:fs";
import {chmod,copyFile,link,lstat,mkdir,mkdtemp,readFile,readdir,readlink,realpath,rm,stat,symlink} from "node:fs/promises";
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

/** Restore Git's executable bit and ordinary checkout permissions for Docker COPY.
 * The CLI configuration view links the pristine blobs. Replacing its config never changes the build context. */
async function checkout(source:string,target:string,linkFiles:boolean) {
  await mkdir(target,{mode:0o755});
  for (const entry of await readdir(source,{withFileTypes:true})) {
    const from=join(source,entry.name),to=join(target,entry.name);
    if (entry.isDirectory()) await checkout(from,to,linkFiles);
    else if (entry.isSymbolicLink()) {
      const dest=await readlink(from);
      if (isAbsolute(dest)) throw Error("absolute symlinks are not portable build inputs");
      await symlink(dest,to);
    } else if (entry.isFile()) {
      if (linkFiles) await link(from,to);
      else {await copyFile(from,to);await chmod(to,(await lstat(from)).mode&0o111 ? 0o755 : 0o644);}
    } else throw Error("unsupported Git build entry");
  }
  await chmod(target,0o755);
}

/** The CLI resolves even soft ordering hints against registries. Keep only edges to the frozen graph. */
async function featureOrder(repo:string,base:string,view:string,features:string[],locked:Record<string,unknown>,override:unknown) {
  const known=new Set(Object.keys(locked));
  const manifests=new Map<string,Record<string,unknown>>();
  async function visit(name:string):Promise<void> {
    known.add(name);
    if (!name.startsWith("./") && !name.startsWith("../")) {
      if (!Object.hasOwn(locked,name)) throw Error("remote Feature dependencies require a frozen lock entry");
      return;
    }
    const feature=await sourcePath(repo,base,name,true);
    const file=await sourcePath(repo,feature,"devcontainer-feature.json",false);
    if (manifests.has(file)) return;
    const errors:ParseError[]=[];
    const metadata=parse(await readText(file),errors,{allowTrailingComma:true});
    if (!metadata || typeof metadata!=="object" || Array.isArray(metadata) || errors.length) throw Error("invalid local Feature metadata");
    checkIsolation(metadata);
    manifests.set(file,metadata);
    if (metadata.dependsOn!==undefined && (!metadata.dependsOn || typeof metadata.dependsOn!=="object" || Array.isArray(metadata.dependsOn))) throw Error("invalid Feature dependencies");
    for (const dependency of Object.keys(metadata.dependsOn ?? {})) await visit(dependency);
  }
  for (const name of features) await visit(name);
  const selected=(order:unknown)=>{
    if (!Array.isArray(order) || !order.every(key=>typeof key==="string" && key.length && !key.includes("${"))) throw Error("invalid Feature order");
    return order.flatMap((key:string)=>{
      if (known.has(key)) return [key];
      // An unversioned OCI ordering hint can refer to an installed version.
      return [...known].filter(name=>name.startsWith(key+":") || name.startsWith(key+"@"));
    });
  };
  const overlays:{path:string;body:string}[]=[];
  for (const [file,metadata] of manifests) {
    if (metadata.installsAfter!==undefined) {
      const installsAfter=selected(metadata.installsAfter);
      overlays.push({path:join(view,relative(repo,file)),body:JSON.stringify({...metadata,installsAfter})});
    }
  }
  return {overlays,order:override===undefined ? undefined : selected(override)};
}

async function runBuild(args:string[],lock:number) {
  const env:NodeJS.ProcessEnv={};
  for (const key of ["PATH","HOME","TMPDIR","LANG","DOCKER_HOST","DOCKER_CONTEXT","DOCKER_CONFIG","DOCKER_CERT_PATH","DOCKER_TLS_VERIFY","XDG_RUNTIME_DIR"]) {
    if (process.env[key]!==undefined) env[key]=process.env[key];
  }
  const child=spawn(cli,args,{env,stdio:["ignore","ignore","ignore",lock]});
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
      let repo:string;
      try {
        const workspace=await new MaterialWorkspaces().prepare(ledger,id,[{name:"source",repository:input.repository,commit:input.commit}]);
        repo=workspace.materials[0]!.path;
      } catch (error) {return {status:"invalid",reason:error instanceof Error ? error.message : "could not read frozen environment sources"};}
      const stage=await mkdtemp(join(root,"attempt-"));
      try {
        const sourceRoot=join(stage,"source"),view=join(stage,"view");
        let planned;
        try {
          planned=await this.plan(repo,input.path,sourceRoot,view,image,owner);
        } catch(error) {return {status:"invalid",reason:error instanceof Error ? error.message : "invalid devcontainer build configuration"};}
        const args=["image","ls","--no-trunc","--filter","reference="+image,"--format","{{.ID}}"];
        const receipt=join(root,"image-id");
        const recorded=existsSync(receipt) ? safeRead(receipt,128).toString() : undefined;
        if (recorded!==undefined && !/^sha256:[a-f0-9]{64}$/.test(recorded)) return {status:"conflict",reason:"invalid frozen build receipt"};
        const existing=recorded ?? (await exec("docker",args)).stdout.trim();
        if (!existing) {
          await checkout(repo,sourceRoot,false);
          await checkout(sourceRoot,view,true);
          for (const overlay of planned.overlays) atomicPrivateWrite(overlay.path,overlay.body);
          atomicPrivateWrite(planned.configPath,JSON.stringify(planned.build));
          if (planned.effectiveLock!==undefined) atomicPrivateWrite(planned.lockPath,planned.effectiveLock);
          await runBuild(["build","--workspace-folder",view,"--config",planned.configPath,"--image-name",image,
            "--oci-auth-hardening",planned.effectiveLock===undefined ? "--no-lockfile" : "--frozen-lockfile"],lock);
        }
        const {stdout}=await exec("docker",["image","inspect","--format",'{{.Id}} {{index .Config.Labels "'+label+'"}}',recorded ?? image]);
        const [imageDigest,actualOwner]=stdout.trim().split(" ");
        if (!imageDigest || !/^sha256:[a-f0-9]{64}$/.test(imageDigest) || actualOwner!==owner) return {status:"conflict",reason:"image does not carry the reserved build identity"};
        if (recorded!==undefined && recorded!==imageDigest) return {status:"conflict",reason:"image differs from the original build receipt"};
        if (recorded===undefined) atomicPrivateWrite(receipt,imageDigest);
        return {status:"built",image:{config:planned.config,source:planned.source,imageDigest,...(planned.lockfile!==undefined ? {lockfile:planned.lockfile} : {})}};
      } catch {return {status:"unavailable",reason:"could not build or verify the owned devcontainer image; retry the original operation"};}
      finally {await rm(stage,{recursive:true,force:true});}
    },120000);
  }

  private async plan(repo:string,path:string,sourceRoot:string,root:string,image:string,owner:string) {
    const original=await sourcePath(repo,repo,path,false);
    const source=await readText(original),errors:ParseError[]=[];
    const config=parse(source.replace(/^\uFEFF/,""),errors,{allowTrailingComma:true});
    if (errors.length || !config || typeof config!=="object" || Array.isArray(config)) throw Error("invalid devcontainer configuration");
    checkIsolation(config);
    if (config.dockerComposeFile) throw Error("this environment builder requires a single image configuration");
    const spec=config.build ?? (config.dockerFile ? {dockerfile:config.dockerFile,context:config.context} : undefined);
    if (spec && (typeof spec!=="object" || Object.keys(spec).some(key=>!["dockerfile","context","args","target"].includes(key)))) throw Error("unsupported devcontainer build setting");
    const base=dirname(original);
    const configPath=join(root,relative(repo,original)),generatedBase=dirname(configPath);
    const context=join(sourceRoot,relative(repo,await sourcePath(repo,base,spec?.context ?? ".",true)));
    let dockerfile;
    if (spec) {
      if (config.image) throw Error("select a Dockerfile or an image");
      dockerfile=join(sourceRoot,relative(repo,await sourcePath(repo,base,spec.dockerfile,false)));
    } else {
      if (typeof config.image!=="string" || !/^[a-z0-9][a-z0-9./_:@-]*$/i.test(config.image)) throw Error("missing or invalid base image");
      dockerfile=join(dirname(root),"Dockerfile");
      atomicPrivateWrite(dockerfile,"FROM "+config.image+"\n");
    }
    if (spec?.args && (Array.isArray(spec.args) || typeof spec.args!=="object" || Object.entries(spec.args).some(([key,v])=>!/^\w+$/.test(key) || typeof v!=="string" || v.includes("${")))) throw Error("expected literal Docker build arguments");
    if (spec?.target && (typeof spec.target!=="string" || !/^[a-z0-9_.-]+$/i.test(spec.target))) throw Error("invalid Dockerfile stage");
    const {build:ignored,dockerFile,context:oldContext,features,overrideFeatureInstallOrder,...launch}=config;
    const configText=JSON.stringify({...launch,image});
    pinnedConfig(configText,"sha256:"+"0".repeat(64));
    let lockfile:string|undefined;
    const lockname=path.endsWith("/.devcontainer.json") || path===".devcontainer.json" ? ".devcontainer-lock.json" : "devcontainer-lock.json";
    try {lockfile=await readText(await sourcePath(repo,base,lockname,false));} catch(error) {if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;}
    const locked=lockfile===undefined ? {} : JSON.parse(lockfile.replace(/^\uFEFF/,""));
    if (!locked || typeof locked!=="object" || Array.isArray(locked)) throw Error("invalid devcontainer lockfile");
    const selected:Record<string,unknown>={};
    if (features!==undefined && (!features || typeof features!=="object" || Array.isArray(features))) throw Error("invalid feature list");
    for (const [name,options] of Object.entries(features ?? {})) {
      if (JSON.stringify(options).includes("${")) throw Error("feature settings require literal build inputs");
      if (name.startsWith("./") || name.startsWith("../")) {
        await sourcePath(repo,base,name,true);
        selected[name]=options;
      } else {
        if (!/^[a-z0-9.-]+\/[a-z0-9._/:-]+$/.test(name) || lockfile===undefined) throw Error("remote features require a frozen lockfile");
        selected[name]=options;
      }
    }
    const hasFeatures=Object.keys(selected).length>0;
    const {overlays,order}=await featureOrder(repo,base,root,Object.keys(selected),locked.features ?? {},overrideFeatureInstallOrder);
    // Frozen-empty proves that a local Feature graph resolves no remote dependencies,
    // including dependencies discovered only while parsing a nested Feature.
    const effectiveLock=lockfile ?? (hasFeatures ? JSON.stringify({features:{}}) : undefined);
    return {source,config:configText,lockfile,effectiveLock,overlays,configPath,lockPath:join(generatedBase,lockname),
      build:{build:{dockerfile:relative(generatedBase,dockerfile),context:relative(generatedBase,context),
        ...(spec?.args ? {args:spec.args} : {}),...(spec?.target ? {target:spec.target} : {}),options:["--label",label+"="+owner]},
        ...(hasFeatures ? {features:selected} : {}),...(order?.length ? {overrideFeatureInstallOrder:order} : {})}};
  }
}
