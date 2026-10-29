import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readEnvironment, environmentPrivateDirectory, saveEnvironment, type EnvironmentRecord } from "./env-environment.js";
import { createHostProcessScope, hostProcessEnvironment, inspectHostProcessScope, signalHostProcessScope, hostProcessIdentity, signalHostProcessLeader, processIdentity, type HostProcessScope } from "./env-process.js";
import { acquireRouteLease, type RouteLease } from "./env-route-lease.js";
import { inspectTaskGit, type RouteReport } from "./env-route-exit.js";
import { validation, stateConflict } from "./errors.js";
import { baseDirectory, findRunFile, readRecord, runDirectory, runFilesOf, environmentDirectory, writeRecord, withEnvironmentOperation } from "./env-store.js";
import { newUUIDv7 } from "./identity.js";
import { privateDirectory, atomicPrivateWrite } from "./runtime-files.js";
import { docker, assertEnvironmentEngine, inspectOwnedContainer, stopOwnedContainer, resourceArguments } from "./env-docker.js";
import { credentialRedactions } from "./env-credentials.js";
export const RUN_FORMAT="grounds.environment-run/v1";
const MAX_LOG=1024*1024;
export type RunState="running"|"succeeded"|"failed"|"cancelled"|"timed_out";
export interface RunRecord {
 format:typeof RUN_FORMAT; id:string;environment_id:string;state:RunState;argv:string[];write_boundary:"container"|"not_enforced";
 network:"none"|"allowed";directory:string;pid?:number;process_identity?:string;container_id?:string;container_removed?:boolean;
 host_scope?:HostProcessScope;
 host_process_identity?:string;
 exit_code?:number|null;signal?:string|null;cancel_requested?:boolean;timeout_requested?:boolean;error?:string;route?:RouteReport;
 started_at:string;finished_at?:string;termination:"unknown"|"confirmed";cleanup:"pending"|"complete";lease?:RouteLease;
 definition_digest:string;image?:string;requirements:EnvironmentRecord["requirements"];log_truncated:boolean;log_bytes:number;
 author_result:"not_reported"; // Command exit never infers author completion or a Verification conclusion.
}
export interface StartedRun {run:RunRecord;done:Promise<RunRecord>}
const redact=(text:string,secrets:string[]):string=>secrets.sort((a,b)=>b.length-a.length).reduce((text,value)=>value?text.split(value).join("[REDACTED]"):text,text);
/** Do not expose a credential prefix while its remaining bytes may be in the next chunk. */
const redactPending=(text:string,secrets:string[],pending:boolean):string=>{
 let safe=redact(text,secrets);
 if(pending)for(const secret of secrets){
  for(let size=Math.min(secret.length-1,safe.length);size>0;size--){
   if(safe.endsWith(secret.slice(0,size))){safe=safe.slice(0,-size)+"[REDACTED_PENDING]";break;}
  }
 }
 return safe;
};
interface LogCheckpoint { observed_bytes:number; truncated:boolean; complete:boolean }
const validateArgv=(argv:string[]):void=>{if(!Array.isArray(argv)||argv.length<1||argv.length>128||argv.some(s=>typeof s!=="string"||s.length===0||s.length>64*1024||s.includes("\0")))throw validation("argv","requires bounded nonempty argument strings without NUL");};
const variables=(env:EnvironmentRecord,container:boolean):Record<string,string>=>{
 const root=container?"":environmentPrivateDirectory(env.id);
 const vars:Record<string,string>={PATH:process.env.PATH??"/usr/bin:/bin",HOME:container?"/home/agent":join(root,"home"),TMPDIR:container?"/tmp":join(root,"tmp"),GROUNDS_WORKSPACE:container?"/workspace":env.workspace,GROUNDS_OUTPUT_DIRECTORY:container?"/output":join(root,"out"),GROUNDS_INPUT_DIRECTORY:container?"/inputs":join(root,"inputs"),GROUNDS_CREDENTIAL_DIRECTORY:container?"/credentials":join(root,"credentials")};
 if(container)delete vars.PATH;else{vars.GROUNDS_BASE_CACHE=join(baseDirectory(env.base_digest),"cache");vars.PATH=join(vars.GROUNDS_BASE_CACHE,"bin")+":"+vars.PATH;}
 for(const binding of env.credentials)vars[`GROUNDS_CREDENTIAL_${binding.name.toUpperCase().replace(/-/g,"_")}_FILE`]=container?`/credentials/${binding.path}`:join(root,"credentials",binding.path);
 for(const service of env.services){const prefix=`GROUNDS_SERVICE_${service.name.toUpperCase().replace(/-/g,"_")}`;vars[prefix+"_HOST"]=service.host;vars[prefix+"_PORT"]=String(service.port);}
 return vars;
};
const dockerCommand=(env:EnvironmentRecord,runId:string,argv:string[],created:(id:string)=>void):string=>{
 assertEnvironmentEngine(env.id);
 const root=environmentPrivateDirectory(env.id);
 const mounts=[ [env.workspace,"/workspace",false],[join(root,"home"),"/home/agent",false],[join(root,"tmp"),"/tmp",false],[join(root,"out"),"/output",false],[join(root,"credentials"),"/credentials",false],[join(root,"inputs"),"/inputs",true] ] as const;
 for(const [source]of mounts)if(source.includes(","))throw validation("workspace","Docker mount paths containing commas are unsupported");
 const id=docker(["create","--label",`grounds.environment=${env.id}`,"--label",`grounds.run=${runId}`,"--init","--log-driver","local","--log-opt","max-size=1m","--log-opt","max-file=1","--log-opt","compress=false","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges","--network",env.requirements.network==="none"?"none":env.network_id??"bridge",...resourceArguments(env.requirements),...mounts.flatMap(([source,target,readonly])=>["--mount",`type=bind,source=${source},target=${target}${readonly?",readonly":""}`]),"--user",`${process.getuid?.()??1000}:${process.getgid?.()??1000}`,"--workdir","/workspace",...Object.entries(variables(env,true)).flatMap(([k,v])=>["--env",`${k}=${v}`]),"--entrypoint",argv[0],env.image!,...argv.slice(1)]);
 created(id);
 for(const network of new Set(env.services.filter(s=>s.ownership==="shared").map(s=>s.network_id)))if(network!==env.network_id)docker(["network","connect",network,id]);
 return id;
};
export const readRun=(runId:string):RunRecord=>{const file=findRunFile(runId);if(!file)throw validation("run_id","no execution with this identifier");return readRecord<RunRecord>(file);};
const saveRun=(run:RunRecord):void=>writeRecord(join(run.directory,"run.json"),run);
const hostLeader=(run:RunRecord)=>run.pid&&run.host_process_identity?{pid:run.pid,identity:run.host_process_identity}:undefined;
const stateFrom=(record:RunRecord,code:number|null):RunState=>record.cancel_requested?"cancelled":record.timeout_requested?"timed_out":code===0?"succeeded":"failed";
const refreshLog=(record:RunRecord,environment:EnvironmentRecord):void=>{
 const file=join(record.directory,"output.log");
 const secrets=credentialRedactions(join(environmentPrivateDirectory(environment.id),"credentials"),environment.credentials);
 const checkpointFile=join(record.directory,"log-checkpoint.json");
 const checkpoint=existsSync(checkpointFile)?readRecord<LogCheckpoint>(checkpointFile):undefined;
 record.log_truncated=record.log_truncated||Boolean(checkpoint?.truncated);
 let contents=existsSync(file)?readFileSync(file,"utf8"):"";
 if(record.container_id&&!record.container_removed&&!checkpoint?.complete){
  const recovered=spawnSync("docker",["logs",record.container_id],{encoding:"utf8",timeout:30000,maxBuffer:MAX_LOG});
  // The bounded engine log can already have rotated before recovery. Retained
  // bytes are useful, but cannot establish the original stream's completeness.
  record.log_truncated=true;
  if(recovered.status===0||(recovered.error as NodeJS.ErrnoException|undefined)?.code==="ENOBUFS"){
   const stdout=Buffer.from(redactPending(recovered.stdout??"",secrets,true));
   const stderr=Buffer.from(redactPending(recovered.stderr??"",secrets,true));
   atomicPrivateWrite(join(record.directory,"stdout.log"),stdout.subarray(0,MAX_LOG));
   atomicPrivateWrite(join(record.directory,"stderr.log"),stderr.subarray(0,Math.max(0,MAX_LOG-stdout.length)));
   contents=(recovered.stdout??"")+(recovered.stderr??"");
  } else record.log_truncated=true;
 }
 const sanitized=Buffer.from(redactPending(contents,secrets,record.log_truncated));
 record.log_truncated=record.log_truncated||sanitized.length>MAX_LOG;
 record.log_bytes=Math.min(sanitized.length,MAX_LOG);
 atomicPrivateWrite(file,sanitized.subarray(0,MAX_LOG));
 for(const stream of ["stdout","stderr"]){const path=join(record.directory,stream+".log");if(existsSync(path))atomicPrivateWrite(path,redact(readFileSync(path,"utf8"),secrets));}

};
/** Recovery observes the same execution; it never dispatches the command again. */
export const reconcileRun=(runId:string):RunRecord=>{
 const record=readRun(runId);const environment=readEnvironment(record.environment_id);
 if(environment.backend==="docker"&&!record.container_id&&!record.container_removed){
  assertEnvironmentEngine(environment.id);
  const matches=docker(["ps","-aq","--no-trunc","--filter",`label=grounds.environment=${environment.id}`,"--filter",`label=grounds.run=${record.id}`]).split("\n").filter(Boolean);
  if(matches.length>1){record.error="ambiguous execution ownership; retaining resources";record.termination="unknown";saveRun(record);return record;}
  if(matches.length===1){record.container_id=matches[0];record.termination="unknown";saveRun(record);}
  else if(!record.pid){record.termination="confirmed";record.state=stateFrom(record,null);record.cleanup="complete";record.finished_at??=new Date().toISOString();saveRun(record);}
 }
 if(record.termination==="confirmed"&&(environment.backend!=="host"||record.host_scope)){return record;}
 try{
  if(record.container_id){
   const actual=inspectOwnedContainer(record.container_id,environment.id);
   if(actual.Config.Labels["grounds.run"]!==record.id)throw stateConflict("run",record.id,"container run identity mismatch");
   if(actual.State.Running)return record;
   record.exit_code=actual.State.Status==="created"?null:actual.State.ExitCode;
   record.termination="confirmed";record.state=stateFrom(record,record.exit_code);
   if(actual.State.OOMKilled)record.error="container exceeded memory limit; command was not retried";
   else if(actual.State.Error)record.error=actual.State.Error.slice(0,512);
  }else if(environment.backend==="host"){
   const observation=record.host_scope?inspectHostProcessScope(record.host_scope,hostLeader(record)):{complete:false,processes:[]};
   if(!observation.complete||observation.processes.length){
    record.termination="unknown";
    if(!observation.complete)record.error="complete host task process observation unavailable; retaining resources";
    saveRun(record);return record;
   }
   record.termination="confirmed";
   if(record.error==="complete host task process observation unavailable; retaining resources")delete record.error;
   if(record.state==="running"){record.state=stateFrom(record,record.exit_code??null);record.error??="controller ended before recording command outcome; no command was replayed";}
  }else{record.error="launch ownership is unknown; retaining all resources";saveRun(record);return record;}
  record.finished_at??=new Date().toISOString();
  if(environment.backend==="host"){
   if(environment.route)record.route=inspectTaskGit(environment.workspace);
  }
  refreshLog(record,environment);record.cleanup=environment.backend==="host"?"pending":"complete";saveRun(record);return record;
 }catch(error){record.error=error instanceof Error?error.message:String(error);saveRun(record);return record;}
};
const startRunUnlocked=(input:{environmentId:string;argv:string[];timeoutMs?:number;requiresNetwork?:boolean;artifacts?:string[]}):StartedRun=>{
 const environment=readEnvironment(input.environmentId);validateArgv(input.argv);
 if(environment.state!=="ready")throw stateConflict("environment",environment.id,"environment is not ready");
 if(input.requiresNetwork&&environment.requirements.network==="none")throw validation("network","selected Agent requires network but frozen definition forbids it");
 const timeout=input.timeoutMs??30*60*1000;if(!Number.isInteger(timeout)||timeout<1||timeout>24*60*60*1000)throw validation("timeout_ms","must be within 24 hours");
 for(const file of runFilesOf(environmentDirectory(environment.id))){const old=readRecord<RunRecord>(file);if(reconcileRun(old.id).termination!=="confirmed")throw stateConflict("environment",environment.id,"a previous execution has not confirmed termination");}
 if(input.artifacts){for(const path of input.artifacts)if(path==="."||path.startsWith("/")||path.split("/").some(p=>!p||p===".."||p==="."))throw validation("artifacts","requires relative output file paths");environment.artifacts=[...new Set([...environment.artifacts,...input.artifacts])];saveEnvironment(environment);}
 // Check the inspection capability before reserving a new run or launching any
 // process. A persisted scope then survives loss of the launching controller.
 const hostScope=environment.backend==="host"?createHostProcessScope():undefined;
 const id=newUUIDv7();const directory=privateDirectory(runDirectory(environment.id,id));
 const secrets=credentialRedactions(join(environmentPrivateDirectory(environment.id),"credentials"),environment.credentials);
 let run:RunRecord={format:RUN_FORMAT,id,environment_id:environment.id,state:"running",argv:input.argv.map(a=>redact(a,secrets)),write_boundary:environment.backend==="docker"?"container":"not_enforced",network:environment.requirements.network==="none"?"none":"allowed",directory,started_at:new Date().toISOString(),termination:"unknown",cleanup:"pending",definition_digest:environment.definition.digest,image:environment.image,requirements:environment.requirements,host_scope:hostScope,log_bytes:0,log_truncated:false,author_result:"not_reported"};
 saveRun(run);atomicPrivateWrite(join(directory,"output.log"),"");
 let child:ChildProcess;
 try{
  if(environment.backend==="docker"){
   run.container_id=dockerCommand(environment,id,input.argv,containerId=>{run.container_id=containerId;saveRun(run);});saveRun(run);
   child=spawn("docker",["start","--attach",run.container_id],{stdio:["ignore","pipe","pipe"]});
  }else{
   run.lease=acquireRouteLease({route:environment.workspace,environmentId:environment.id,runDirectory:directory,runId:id});saveRun(run);
   child=spawn(input.argv[0],input.argv.slice(1),{cwd:environment.workspace,env:{...variables(environment,false),...hostProcessEnvironment(hostScope!)},detached:true,stdio:["ignore","pipe","pipe"]});
  }
  run.pid=child.pid;if(child.pid){if(hostScope)run.host_process_identity=hostProcessIdentity(child.pid);run.process_identity=processIdentity(child.pid);}saveRun(run);
 }catch(error){run.state="failed";run.error=error instanceof Error?error.message:String(error);run.finished_at=new Date().toISOString();if(!run.container_id){run.termination="confirmed";}saveRun(run);throw error;}
 let logged=0;let buffered=0;const chunks:{stream:"stdout"|"stderr";bytes:Buffer}[]=[];
 const observedSecrets=new Set(secrets);
 const flushLog=(complete:boolean):void=>{
  for(const value of credentialRedactions(join(environmentPrivateDirectory(environment.id),"credentials"),environment.credentials))observedSecrets.add(value);
  const currentSecrets=[...observedSecrets];
  const persist=(name:string,parts:Buffer[]):number=>{
   const bytes=Buffer.from(redactPending(Buffer.concat(parts).toString(),currentSecrets,!complete||logged>buffered));
   atomicPrivateWrite(join(directory,name),bytes.subarray(0,MAX_LOG));
   return bytes.length;
  };
  const length=persist("output.log",chunks.map(c=>c.bytes));
  for(const stream of ["stdout","stderr"] as const)persist(stream+".log",chunks.filter(c=>c.stream===stream).map(c=>c.bytes));
  writeRecord(join(directory,"log-checkpoint.json"),{observed_bytes:logged,truncated:logged>MAX_LOG||length>MAX_LOG,complete} satisfies LogCheckpoint);
 };
 const log=(stream:"stdout"|"stderr",chunk:Buffer|string):void=>{
  const bytes=Buffer.from(chunk);logged+=bytes.length;
  if(buffered<MAX_LOG){const keep=bytes.subarray(0,MAX_LOG-buffered);chunks.push({stream,bytes:keep});buffered+=keep.length;}
  // atomicPrivateWrite fsyncs before publishing; command/controller exit is
  // not the first occasion on which already-observed output reaches disk.
  flushLog(false);
 };
 child.stdout?.on("data",chunk=>log("stdout",chunk));child.stderr?.on("data",chunk=>log("stderr",chunk));
 const done=new Promise<RunRecord>(resolve=>{
  let settled=false;
  const timer=setTimeout(()=>{const current=readRun(id);current.timeout_requested=true;saveRun(current);try{terminateRun(current);}catch{}},timeout);
  const finish=(code:number|null,signal:NodeJS.Signals|null,error?:string):void=>{
   if(settled)return;settled=true;clearTimeout(timer);
   flushLog(true);
   const current=readRun(id);current.exit_code=code;current.signal=signal;current.state=stateFrom(current,code);current.finished_at=new Date().toISOString();current.log_truncated=logged>MAX_LOG;current.log_bytes=Math.min(logged,MAX_LOG);if(error)current.error=error;
   if(!current.pid&&!current.container_id){current.termination="confirmed";}
   saveRun(current);
   const observe=async():Promise<void>=>{
    let result=reconcileRun(id);
    // Process exit and native enumeration can race. Retry the observation for
    // a short bounded interval; an unresolved scan still returns unknown.
    for(let attempt=0;environment.backend==="host"&&result.termination!=="confirmed"&&attempt<20;attempt++){
     await new Promise(r=>setTimeout(r,25));result=reconcileRun(id);
    }
    resolve(result);
   };
   void observe();
  };
  child.once("error",error=>finish(null,null,error.message.slice(0,256)));child.once("close",(code,signal)=>finish(code,signal));
 });
 return {run,done};
};
const terminateRun=(record:RunRecord):void=>{
 if(record.container_id){stopOwnedContainer(record.container_id,record.environment_id);return;}
 if(!record.host_scope)throw stateConflict("run",record.id,"host task identity unavailable; retaining resources");
 if(record.pid&&record.host_process_identity)signalHostProcessLeader(record.pid,record.host_process_identity,"SIGTERM");
 signalHostProcessScope(record.host_scope,"SIGTERM",hostLeader(record));
 // Keep this controller alive through escalation, including standalone cancel
 // calls. An unref'ed timer could otherwise exit before stopping descendants.
 setTimeout(()=>{
  if(record.pid&&record.host_process_identity)signalHostProcessLeader(record.pid,record.host_process_identity,"SIGKILL");
  signalHostProcessScope(record.host_scope!,"SIGKILL",hostLeader(record));
 },2000);
};
export const cancelRun=(runId:string):RunRecord=>{
 const record=readRun(runId);
 if(record.termination==="confirmed"&&reconcileRun(runId).termination==="confirmed")return readRun(runId);
 record.cancel_requested=true;saveRun(record);
 try{terminateRun(record);}catch(error){record.error=error instanceof Error?error.message:String(error);saveRun(record);}
 return reconcileRun(runId);
};

export const startRun = (input: Parameters<typeof startRunUnlocked>[0]): StartedRun => withEnvironmentOperation(input.environmentId,()=>startRunUnlocked(input));
