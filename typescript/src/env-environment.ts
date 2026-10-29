import { existsSync, realpathSync, rmSync, statSync, lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { assertCapabilities, hostCapabilities, dockerCapabilities, effectiveRequirements, type CapabilityMatrix } from "./env-capabilities.js";
import { materializeBase } from "./env-base.js";
import { environmentDefinitionOf, type EnvironmentBackendKind, type EnvironmentDefinition, type EnvironmentRequirements } from "./env-definition.js";
import { isRouteWorkspace, isRouteLeased, releaseRouteLease } from "./env-route-lease.js";
import { stateConflict, validation } from "./errors.js";
import { environmentDirectory, instanceDirectories, readRecord, requireId, runFilesOf, writeRecord, withEnvironmentOperation } from "./env-store.js";
import { newUUIDv7 } from "./identity.js";
import { privateDirectory, atomicPrivateWrite, safeRead, digestBytes } from "./runtime-files.js";
import { initializeTaskRepository, type MaterialScope } from "./env-seed.js";
import { authorizeCredentials, injectCredentials, syncCredentials, credentialRedactions, withCredentialPreparation, type CredentialBinding } from "./env-credentials.js";
import { createTaskNetwork, prepareServices, releaseServices, removeTaskNetwork, type PreparedService } from "./env-services.js";
import { inspectTaskGit, type RouteReport } from "./env-route-exit.js";
import { docker, inspectOwnedContainer, removeOwnedContainer, resourceArguments } from "./env-docker.js";
import { reconcileRun, type RunRecord } from "./env-run.js";
import { receiveDevelopmentObjects } from "./development-branch.js";
import { git } from "./env-git.js";
export const ENVIRONMENT_FORMAT = "grounds.environment/v1";
export interface EnvironmentRecord {
  format: typeof ENVIRONMENT_FORMAT; id: string; directory: string; definition: { name: string; digest: string; implicit: boolean }; definition_snapshot: EnvironmentDefinition;
  backend: EnvironmentBackendKind; requirements: EnvironmentRequirements; base_digest: string; image?: string; engine_id?: string;
  workspace: string; original_workspace: string; route: boolean; created_at: string; state: "preparing"|"ready"|"blocked"|"released";
  trust: "trusted_host"|"container"; disclosure: string; repository_id?: string; dev_run_id?: string;
  input?: { source_commit: string; commit: string; tree: string; scope: MaterialScope; branch: string };
  credentials: CredentialBinding[]; services: PreparedService[]; network_id?: string; artifacts: string[]; inputs: {name:string;digest:string}[];
  handoff?: { target: string; source_commit: string; tree: string; parents: string[]; ref: string };
  cleanup?: { state: "pending"|"blocked"|"complete"; reason?: string; git?: RouteReport; artifacts?: {path:string;state:string;bytes?:number}[] };
  error?: string;
}
const fileOf = (id: string): string => join(environmentDirectory(id), "environment.json");
export const saveEnvironment = (record: EnvironmentRecord): void => writeRecord(fileOf(record.id),record);
export const environmentPrivateDirectory = (id: string): string => join(environmentDirectory(id),"private");
export interface EnvironmentUpInput {
  definition: EnvironmentDefinition; workspace: string; capabilities?: CapabilityMatrix; inputCommit?: string; branch?: string; materialScope?: MaterialScope;
  taskRepositoryId?: string; resolvedRepositoryId?: string; devRunId?: string; fixedInputs?: { name: string; path: string }[];
}
export const environmentUp = async (input: EnvironmentUpInput): Promise<EnvironmentRecord> => {
  const workspace = realpathSync(input.workspace);
  if (!statSync(workspace).isDirectory()) throw validation("workspace", "requires existing directory");
  const definition = environmentDefinitionOf(input.definition);
  if (definition.repositories.length !== 1 || definition.repositories[0].path !== ".") throw validation("repositories","only the current task repository is supported");
  if (definition.backend === "host" && !["darwin","linux"].includes(process.platform)) throw validation("backend","trusted host supports macOS and Linux");
  if (isRouteLeased(workspace)) throw stateConflict("environment", "workspace", "workspace is occupied or has unresolved legacy private Git");
  const requirements = effectiveRequirements(definition.requirements,definition.backend);
  assertCapabilities({ requirements, capabilities: input.capabilities ?? (definition.backend === "host" ? hostCapabilities() : dockerCapabilities()) });
  if (definition.backend === "host" && definition.services.length) throw validation("services","managed services require Docker; host has no service isolation");
  if (requirements.network === "none" && definition.services.length) throw validation("services","network-none tasks cannot connect dependency services");
  if (definition.backend === "docker" && !input.inputCommit) throw validation("input_commit","Docker requires an explicit fixed input commit supplied by the coordinator");
  const credentials = authorizeCredentials({ declarations: definition.credentials, environment: definition.name, taskRepositoryId: input.taskRepositoryId, resolvedRepositoryId: input.resolvedRepositoryId });
  if (definition.services.some(s=>s.shared) && (!input.taskRepositoryId || input.taskRepositoryId!==input.resolvedRepositoryId)) throw validation("repository","shared services require matching task repository resolution");
  const fixedInputs = (input.fixedInputs ?? []).map(item=> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(item.name)) throw validation("fixed_inputs","each fixed input must be one named regular file");
    return { name:item.name,bytes:safeRead(item.path,16*1024*1024) };
  });
  if (new Set(fixedInputs.map(i=>i.name)).size !== fixedInputs.length) throw validation("fixed_inputs","duplicate input names");
  const base = await materializeBase(definition,workspace);
  const prepared = withCredentialPreparation(credentials, () => {
    const id = newUUIDv7();
    const directory = environmentDirectory(id);
    const privateDir = environmentPrivateDirectory(id);
    for (const name of ["home","tmp","out","credentials","inputs"]) privateDirectory(join(privateDir,name));
    privateDirectory(join(directory,"runs"));
    const record: EnvironmentRecord = { format: ENVIRONMENT_FORMAT,id,directory,definition:{name:definition.name,digest:definition.digest,implicit:input.definition.implicit===true},definition_snapshot:definition,backend:definition.backend,requirements,base_digest:base.identity,...(base.image?{image:base.image,engine_id:docker(["info","--format","{{.ID}}"]) }:{}),workspace:definition.backend==="host"?workspace:join(privateDir,"workspace"),original_workspace:workspace,route:existsSync(join(workspace,".git")),created_at:new Date().toISOString(),state:"preparing",trust:definition.backend==="host"?"trusted_host":"container",disclosure:definition.backend==="host"?"Trusted local execution: no enforced file, network, process or resource isolation; declared setup also runs with host permissions.":"Container task: private repository and files, bounded resources; normal outbound network is not an exfiltration filter. Authorized programs can read supplied credentials.",...(input.taskRepositoryId?{repository_id:input.taskRepositoryId}:{}),...(input.devRunId?{dev_run_id:input.devRunId}:{}),credentials,services:[],artifacts:definition.artifacts??[],inputs:fixedInputs.map(i=>({name:i.name,digest:digestBytes(i.bytes)})),cleanup:{state:"pending"} };
    saveEnvironment(record);
    return { id, privateDir, record };
  });
  const { id, privateDir } = prepared;
  let record = prepared.record;
  try {
    if (definition.backend === "docker") {
      const branch = input.branch ?? "grounds/task/"+id;
      const initialized = initializeTaskRepository({ source:workspace,commit:input.inputCommit!,destination:record.workspace,branch,scope:input.materialScope??"development" });
      record.input={...initialized,scope:input.materialScope??"development",branch};saveEnvironment(record);
      if (definition.services.length) { record.network_id=createTaskNetwork(id);saveEnvironment(record); record.services=await prepareServices({ environmentId:id, networkId:record.network_id,declarations:definition.services,requirements,repositoryId:input.taskRepositoryId,environment:definition.name,checkpoint:services=>{record.services=[...services];saveEnvironment(record);} }); }
      // Preparation verifies every declared required CLI inside the fixed image, not on the host.
      const check = ["git",...(definition.tools??[])];
      docker(["run","--rm","--network","none","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges",...resourceArguments(requirements),"--entrypoint","/bin/sh",base.image!,"-c",'for tool do command -v "$tool" >/dev/null || exit 127; done',"check",...check]);
    } else {
      for (const tool of definition.tools??[]) { const {execFileSync}=await import("node:child_process");execFileSync("/bin/sh",["-c",'command -v "$1" >/dev/null',"check",tool],{env:{PATH:join(base.cache,"bin")+":"+(process.env.PATH??"/usr/bin:/bin")}}); }
    }
    for (const item of fixedInputs) atomicPrivateWrite(join(privateDir,"inputs",item.name),item.bytes);
    injectCredentials(join(privateDir,"credentials"),credentials);
    record.state="ready";saveEnvironment(record);return record;
  } catch (error) { record.state="blocked";record.error=error instanceof Error?error.message:String(error);saveEnvironment(record);throw stateConflict("environment",id,`preparation incomplete; resources retained: ${record.error}`); }
};
export const readEnvironment = (id: string): EnvironmentRecord => {
  try { return readRecord<EnvironmentRecord>(fileOf(requireId("environment_id",id))); }
  catch { throw validation("environment_id","no readable environment with this identifier"); }
};
export const listEnvironments = (): EnvironmentRecord[] => instanceDirectories().filter(d=>existsSync(join(d,"environment.json"))).map(d=>readRecord<EnvironmentRecord>(join(d,"environment.json"))).sort((a,b)=>a.created_at.localeCompare(b.created_at));
export const reconcileEnvironment = (id: string): EnvironmentRecord => {
  let record=readEnvironment(id);
  if (record.state === "released") return record;
  try {
    for (const file of runFilesOf(environmentDirectory(id))) {
      const run = readRecord<RunRecord>(file);const recovered = reconcileRun(run.id);
      if (recovered.termination !== "confirmed") throw stateConflict("environment",id,"execution termination is not confirmed; cancel/reconcile the same run");
    }
    record=readEnvironment(id);record.cleanup={...record.cleanup,state:"pending"};saveEnvironment(record);return record;
  } catch(error) {record.cleanup={...record.cleanup,state:"blocked",reason:error instanceof Error?error.message:String(error)};saveEnvironment(record);return record;}
};
const handoffEnvironmentUnlocked = (input: { environmentId: string; target: string; sourceCommit: string }): EnvironmentRecord => {
  const record=reconcileEnvironment(input.environmentId);
  if (record.backend!=="docker" || !record.input || record.cleanup?.state==="blocked") throw stateConflict("environment",record.id,"handoff requires a stopped Docker task with readable input binding");
  const source=input.sourceCommit.replace(/^sha(?:1|256):/,"");
  const state=inspectTaskGit(record.workspace,source,true);
  if (state.pending.length) throw stateConflict("environment",record.id,`Git state requires explicit recovery: ${state.pending.join(", ")}`);
  const target=realpathSync(input.target);
  if (target.startsWith(environmentDirectory(record.id)+"/") || target===environmentDirectory(record.id)) throw validation("target","handoff target must survive instance cleanup");
  if (record.input.scope === "development") git(["merge-base", "--is-ancestor", record.input.commit, source], { cwd: record.workspace });
  if (git(["rev-parse", `${record.input.source_commit}^{tree}`], { cwd: target }) !== record.input.tree) throw validation("target", "target does not contain the task repository fixed input");
  const received=receiveDevelopmentObjects({target_path:target,source_path:record.workspace,source_commit:`${source.length===64?"sha256":"sha1"}:${source}`,environment_id:record.id});
  record.handoff={target,...received};saveEnvironment(record);return record;
};
const collectArtifacts = (record: EnvironmentRecord): {path:string;state:string;bytes?:number}[] => {
  const root=join(environmentPrivateDirectory(record.id),"out");
  return record.artifacts.map(path=> {
    if (path==="." || path.startsWith("/") || path.split("/").some(p=>!p || p===".." || p===".")) return {path,state:"invalid"};
    try {
      const source=join(root,path);
      if (!realpathSync(source).startsWith(realpathSync(root)+"/")) return {path,state:"outside_output"};
      const bytes=safeRead(source,16*1024*1024);
      if (credentialRedactions(join(environmentPrivateDirectory(record.id),"credentials"),record.credentials).some(value=>bytes.includes(Buffer.from(value)))) return {path,state:"credential_material_rejected"};
      atomicPrivateWrite(join(environmentDirectory(record.id),"artifacts",path),bytes);
      return {path,state:"collected",bytes:bytes.length};
    } catch(error) {return {path,state:(error as NodeJS.ErrnoException).code==="ENOENT"?"missing":"unreadable_or_oversize"};}
  });
};
/** Retryable after the released checkpoint, including a controller exit before unlinking occupancy. */
const releaseHostOccupancy = (id: string): void => {
  const runs = runFilesOf(environmentDirectory(id)).map(file => ({ file, run: readRecord<RunRecord>(file) }));
  const leases = new Map(runs.flatMap(({run}) => run.lease ? [[run.lease.file, run.lease] as const] : []));
  for (const lease of leases.values()) releaseRouteLease(lease, true);
  for (const {file,run} of runs) if (run.cleanup !== "complete") writeRecord(file,{...run,cleanup:"complete"});
};
/** Explicit finalization preserves summaries/logs. Only recorded task-owned private resources are reclaimed. */
const environmentDownUnlocked = (id: string): void => {
  let record=reconcileEnvironment(id);
  if (record.state==="released") { if(record.backend==="host") releaseHostOccupancy(id); return; }
  if (record.cleanup?.state==="blocked") throw stateConflict("environment",id,record.cleanup.reason??"cleanup blocked");
  try {
    if (record.backend==="docker" && existsSync(record.workspace)) {
      const source=record.handoff?.source_commit.replace(/^sha(?:1|256):/,"") ?? record.input?.commit;
      const report=inspectTaskGit(record.workspace,source,true);record.cleanup={state:"pending",git:report};saveEnvironment(record);
      if (report.pending.length) throw stateConflict("environment",id,`Git scene retained: ${report.pending.join(", ")}`);
      if (report.head!==record.input?.commit && !record.handoff) throw stateConflict("environment",id,"unique commit has not been handed off");
      if (record.handoff) {
        const expected=record.handoff.source_commit.replace(/^sha(?:1|256):/,"");
        if (git(["rev-parse",record.handoff.ref],{cwd:record.handoff.target})!==expected || git(["rev-parse",`${expected}^{tree}`],{cwd:record.handoff.target})!==record.handoff.tree.replace(/^sha(?:1|256):/,"")) throw stateConflict("environment",id,"external Git receipt no longer verifies");
      }
    }
    const artifacts=collectArtifacts(record);record.cleanup={...record.cleanup,state:"pending",artifacts};saveEnvironment(record);
    if (artifacts.some(a=>a.state!=="collected")) throw stateConflict("environment",id,"declared artifact collection incomplete; scene retained");
    record.credentials=syncCredentials(join(environmentPrivateDirectory(id),"credentials"),record.credentials);saveEnvironment(record);
    for (const file of runFilesOf(environmentDirectory(id))) {const run=readRecord<RunRecord>(file);if(run.container_id&&!run.container_removed){removeOwnedContainer(run.container_id,id);writeRecord(file,{...run,container_removed:true});}}
    releaseServices(id,record.services,remaining=>{record.services=remaining;saveEnvironment(record);});
    if(record.network_id){removeTaskNetwork(record.network_id,id);delete record.network_id;saveEnvironment(record);}
    rmSync(environmentPrivateDirectory(id),{recursive:true,force:true});
    record.state="released";record.cleanup={...record.cleanup,state:"complete"};saveEnvironment(record);
    if(record.backend==="host") releaseHostOccupancy(id);
  }catch(error){record.cleanup={...record.cleanup,state:"blocked",reason:error instanceof Error?error.message:String(error)};saveEnvironment(record);throw error;}
};

export const environmentDown = (id: string): void => withEnvironmentOperation(id,()=>environmentDownUnlocked(id));
export const handoffEnvironment = (input: Parameters<typeof handoffEnvironmentUnlocked>[0]): EnvironmentRecord => withEnvironmentOperation(input.environmentId,()=>handoffEnvironmentUnlocked(input));
