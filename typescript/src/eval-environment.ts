/** Environment contracts are data. Execution remains in the external helper. */
import { object, textValue, versionValue, idValue, refValue, type Ref } from './evaluation.js';
import { validation } from './errors.js';
import { isSha256 } from './identity.js';
import { sha256 } from './canonical-json.js';
import type { ReadTx } from './store-types.js';

export type EnvironmentRef = Ref & { digest: string };
export type Parameters = Record<string, string | number | boolean>;
export interface EnvironmentDefinition {
  format: 'grounds.eval-environment/v1'; name: string; task_kind: 'qa' | 'coding'; role: 'answer' | 'grade';
  parameters: Record<string, { type: 'string' | 'number' | 'boolean'; required: boolean }>;
  script: { interpreter: string; content: string };
  execution: { backend: string; timeout_seconds: number; network_hosts: string[] };
  access: { read_roles: ('code' | 'doc' | 'fixture')[]; kb: boolean; writable_workspace: boolean };
  skills?: { name: string; entrypoint: 'SKILL.md' }[];
}
export interface EvidenceFile { name: string; digest: string; size: number }
export interface AdapterIdentity { name: string; version: string; platform: string }
export interface EnvironmentCheck {
  format: 'grounds.environment-validation/v1'; environment: EnvironmentRef; adapter: AdapterIdentity; parameters: Parameters;
  checks: { success: boolean; failure: boolean; protocol: boolean; isolation: boolean }; files: EvidenceFile[];
}
export interface EnvironmentBinding { environment: EnvironmentRef; parameters: Parameters; validation: Ref; execution_config: Record<string, unknown> }
export interface ExperimentEnvironment { answer: EnvironmentBinding; grade: EnvironmentBinding }
export interface ResourceSource { kind: 'git' | 'kb' | 'file'; identity: string; revision: string; role: string; branch?: string }
export interface PreparationResult {
  format: 'grounds.environment-preparation-result/v1'; attempt_id: string; status: 'success' | 'failed';
  error?: { stage: string; message: string; details?: string };
  workspace?: { root: string; materials: { id: string; role: 'code' | 'doc' | 'fixture'; path: string }[] };
  tools?: { name: string; version: string; entry: string }[]; sources?: ResourceSource[];
  skills?: { name: string; root: string; entrypoint: 'SKILL.md'; bundle_digest: string; file_count: number; total_bytes: number }[];
}
export interface Preparation {
  format: 'grounds.environment-preparation/v1'; environment: EnvironmentRef; parameters: Parameters; adapter: AdapterIdentity;
  experiment_ids: string[]; owner: string; attempt: number; state: 'registered' | 'success' | 'failed' | 'released';
  result?: PreparationResult; duration_ms: number; files: EvidenceFile[]; manifest_digest?: string;
  preparation_contract_digest?: string;
}
export type InstanceState = 'registered' | 'preparing' | 'prepare_failed' | 'ready' | 'launch_intent' | 'running' | 'collected' | 'unknown' | 'aborted' | 'cancelled';
export interface EnvironmentInstance {
  format: 'grounds.environment-instance/v1'; run_id: string; execution_id?: string; role: 'answer' | 'grade';
  environment: EnvironmentRef; preparation_id: string; state: InstanceState; attempt: number;
  input_digest: string; policy_digest?: string; manifest_digest?: string; session_id?: string;
  validity: 'pending' | 'valid' | 'invalid' | 'unknown'; release: 'pending' | 'released' | 'failed';
  duration_ms: number; reason?: string; files: EvidenceFile[];
}
export interface InstanceReference { instance: Ref; preparation: Ref }
export interface EnvironmentMetrics { duration_ms: number; usage: null | { input_tokens: number; output_tokens: number; cached_input_tokens?: number }; source: string }

export const digestValue = (v: unknown): string => { if (!isSha256(v)) throw validation('digest', 'expected SHA-256'); return v as string; };
export const relativePath = (v: unknown): string => {
  const s = textValue(v); if (s.startsWith('/') || s.includes('\\') || s.includes('\0') || s.split('/').some(x => !x || x === '.' || x === '..')) throw validation('path', 'expected safe relative path'); return s;
};
const enumeration = <T extends string>(v: unknown, values: readonly T[], field: string): T => {
  if (!values.includes(v as T)) throw validation(field, `expected ${values.join(', ')}`); return v as T;
};
const boolean = (v: unknown): boolean => { if (typeof v !== 'boolean') throw validation('boolean', 'expected boolean'); return v; };
const skillName = (v: unknown): string => {
  const value=textValue(v,'skill.name',64);if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))throw validation('skill.name','expected lowercase letters, digits, and single hyphens');return value;
};
const declaredSkills = (v: unknown): NonNullable<EnvironmentDefinition['skills']> => {
  const skills=list(v,32).map(x=>{const s=object(x,['name','entrypoint']);if(s.entrypoint!=='SKILL.md')throw validation('skill.entrypoint','first adapter requires SKILL.md');return {name:skillName(s.name),entrypoint:'SKILL.md' as const};});
  if(new Set(skills.map(s=>s.name)).size!==skills.length)throw validation('skills','duplicate names');return skills;
};
export const list = (v: unknown, max = 1000): unknown[] => { if (!Array.isArray(v) || v.length > max) throw validation('array', `expected at most ${max} items`); return v; };
export const parametersValue = (v: unknown): Parameters => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw validation('parameters', 'expected object');
  const result: Parameters = {};
  for (const [k,x] of Object.entries(v)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k) || !['string','boolean','number'].includes(typeof x) || (typeof x === 'number' && !Number.isFinite(x))) throw validation('parameters', 'expected named scalar parameters');
    if (typeof x === 'string') textValue(x); result[k] = x as Parameters[string];
  }
  return result;
};
export const filesValue = (v: unknown): EvidenceFile[] => {
  const result = list(v, 100).map(x => {
    const f = object(x, ['name','digest','size']); const name = textValue(f.name);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)) throw validation('name', 'expected evidence filename');
    const size = versionValue(f.size, 0); if (size > 32 * 1024 * 1024) throw validation('size', 'maximum 32 MiB');
    return { name, digest: digestValue(f.digest), size };
  });
  if (new Set(result.map(x => x.name)).size !== result.length || result.reduce((n,x)=>n+x.size,0) > 128*1024*1024) throw validation('files','duplicate names or bundle exceeds 128 MiB');
  return result;
};
export const environmentRef = (v: unknown): EnvironmentRef => { const o=object(v,['id','version','digest']); return {...refValue({id:o.id,version:o.version}),digest:digestValue(o.digest)}; };
export const adapterValue = (v: unknown): AdapterIdentity => { const o=object(v,['name','version','platform']); return {name:textValue(o.name),version:textValue(o.version),platform:textValue(o.platform)}; };
export const decodeEnvironment = (v: unknown): EnvironmentDefinition => {
  const o=object(v,['format','name','task_kind','role','parameters','script','execution','access'],['skills']);
  if(o.format!=='grounds.eval-environment/v1') throw validation('format','expected grounds.eval-environment/v1');
  const params=o.parameters; if(!params || typeof params!=='object' || Array.isArray(params)) throw validation('parameters','expected object');
  const parameters: EnvironmentDefinition['parameters']={};
  for(const [k,v] of Object.entries(params)) { if(!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k)) throw validation('parameter','invalid name'); const p=object(v,['type','required']); parameters[k]={type:enumeration(p.type,['string','number','boolean'],'type'),required:boolean(p.required)}; }
  const script=object(o.script,['interpreter','content']); const execution=object(o.execution,['backend','timeout_seconds','network_hosts']); const access=object(o.access,['read_roles','kb','writable_workspace']);
  const timeout=versionValue(execution.timeout_seconds); if(timeout>3600) throw validation('timeout_seconds','maximum 3600');
  const read_roles=list(access.read_roles,3).map(x=>enumeration(x,['code','doc','fixture'] as const,'role'));
  if(new Set(read_roles).size!==read_roles.length) throw validation('read_roles','duplicates');
  const role=enumeration(o.role,['answer','grade'],'role'); const kb=boolean(access.kb); const writable=boolean(access.writable_workspace);
  if(role==='grade' && (kb||read_roles.length||writable)) throw validation('access','grading reads only the frozen packet');
  const skills=o.skills===undefined?undefined:declaredSkills(o.skills);if(role==='grade'&&skills?.length)throw validation('skills','grading environments cannot declare skills');
  return {format:o.format,name:textValue(o.name),task_kind:enumeration(o.task_kind,['qa','coding'],'task_kind'),role,parameters,script:{interpreter:textValue(script.interpreter),content:textValue(script.content,'script',1024*1024)},execution:{backend:textValue(execution.backend),timeout_seconds:timeout,network_hosts:list(execution.network_hosts,100).map(x=>textValue(x))},access:{read_roles,kb,writable_workspace:writable},...(skills?{skills}:{})};
};
export function checkParameters(definition: EnvironmentDefinition, values: Parameters): void {
  for(const [k,x] of Object.entries(values)) if(!definition.parameters[k] || typeof x!==definition.parameters[k].type) throw validation('parameters',`unexpected parameter or type: ${k}`);
  for(const [k,p] of Object.entries(definition.parameters)) if(p.required && !(k in values)) throw validation('parameters',`missing ${k}`);
}
export function supportedEnvironment(d: EnvironmentDefinition): void {
  if(d.execution.backend!=='docker') throw validation('environment','historical backend is read-only; new evaluation requires the unified Docker environment');
  if(d.execution.network_hosts.length) throw validation('network_hosts','domain allowlists are unsupported; new unified environments require an empty list');
}
export const decodeEnvironmentCheck=(v:unknown):EnvironmentCheck=>{
 const o=object(v,['format','environment','adapter','parameters','checks','files']); if(o.format!=='grounds.environment-validation/v1') throw validation('format','invalid validation format');
 const c=object(o.checks,['success','failure','protocol','isolation']);return {format:o.format,environment:environmentRef(o.environment),adapter:adapterValue(o.adapter),parameters:parametersValue(o.parameters),checks:{success:boolean(c.success),failure:boolean(c.failure),protocol:boolean(c.protocol),isolation:boolean(c.isolation)},files:filesValue(o.files)};
};
export const decodeBinding=(v:unknown):EnvironmentBinding=>{
 const o=object(v,['environment','parameters','validation','execution_config']);const config=o.execution_config;
 if(!config||typeof config!=='object'||Array.isArray(config)||Buffer.byteLength(JSON.stringify(config))>65536) throw validation('execution_config','expected non-secret config object up to 64 KiB');
 return {environment:environmentRef(o.environment),parameters:parametersValue(o.parameters),validation:refValue(o.validation),execution_config:config as Record<string,unknown>};
};
export const decodeExperimentEnvironment=(v:unknown):ExperimentEnvironment=>{const o=object(v,['answer','grade']);return {answer:decodeBinding(o.answer),grade:decodeBinding(o.grade)};};
export const decodePreparationResult=(v:unknown):PreparationResult=>{
 const o=object(v,['format','attempt_id','status'],['error','workspace','tools','sources','skills']); if(o.format!=='grounds.environment-preparation-result/v1') throw validation('format','invalid preparation result');
 const status=enumeration(o.status,['success','failed'],'status');const base={format:o.format,attempt_id:textValue(o.attempt_id),status} as PreparationResult;
 if(status==='failed') { if(o.workspace!==undefined||o.tools!==undefined||o.sources!==undefined||o.skills!==undefined) throw validation('result','failed result cannot claim ready resources'); const e=object(o.error,['stage','message'],['details']);return {...base,error:{stage:textValue(e.stage),message:textValue(e.message),...(e.details!==undefined?{details:textValue(e.details)}:{})}}; }
 if(o.error!==undefined) throw validation('error','success cannot carry error');const w=object(o.workspace,['root','materials']);
 const materials=list(w.materials).map(x=>{const m=object(x,['id','role','path']);return {id:textValue(m.id),role:enumeration(m.role,['code','doc','fixture'],'role'),path:relativePath(m.path)};});
 if(new Set(materials.map(x=>x.id)).size!==materials.length) throw validation('materials','duplicate ID');
 const skills=o.skills===undefined?undefined:list(o.skills,32).map(x=>{const s=object(x,['name','root','entrypoint','bundle_digest','file_count','total_bytes']);if(s.entrypoint!=='SKILL.md')throw validation('skill.entrypoint','first adapter requires SKILL.md');const file_count=versionValue(s.file_count,1);const total_bytes=versionValue(s.total_bytes,1);if(file_count>1000)throw validation('skill.file_count','maximum 1000');if(total_bytes>32*1024*1024)throw validation('skill.total_bytes','maximum 32 MiB');return {name:skillName(s.name),root:relativePath(s.root),entrypoint:'SKILL.md' as const,bundle_digest:digestValue(s.bundle_digest),file_count,total_bytes};});
 if(skills&&new Set(skills.map(s=>s.name)).size!==skills.length)throw validation('skills','duplicate names');
 return {...base,workspace:{root:relativePath(w.root),materials},tools:list(o.tools).map(x=>{const t=object(x,['name','version','entry']);return {name:textValue(t.name),version:textValue(t.version),entry:textValue(t.entry)};}),sources:list(o.sources).map(x=>{const r=object(x,['kind','identity','revision','role'],['branch']);return {kind:enumeration(r.kind,['git','kb','file'],'kind'),identity:textValue(r.identity),revision:textValue(r.revision),role:textValue(r.role),...(r.branch!==undefined?{branch:textValue(r.branch)}:{})};}),...(skills?{skills}:{})};
};
export const decodePreparation=(v:unknown):Preparation=>{
 const o=object(v,['format','environment','parameters','adapter','experiment_ids','owner','attempt','state','duration_ms','files'],['result','manifest_digest','preparation_contract_digest']);if(o.format!=='grounds.environment-preparation/v1')throw validation('format','invalid preparation');
 const state=enumeration(o.state,['registered','success','failed','released'],'state');const result=o.result===undefined?undefined:decodePreparationResult(o.result);
 if(state==='registered' && (result||o.manifest_digest||o.duration_ms!==0||list(o.files).length))throw validation('preparation','registered state cannot claim execution evidence');
 if(state==='success' && (result?.status!=='success'||!o.manifest_digest))throw validation('result','successful preparation needs result and manifest');
 if(state==='failed' && result?.status!=='failed')throw validation('result','failed preparation needs diagnostics');
 const ids=list(o.experiment_ids).map(idValue);if(!ids.length||new Set(ids).size!==ids.length)throw validation('experiment_ids','need unique experiments');
 return {format:o.format,environment:environmentRef(o.environment),parameters:parametersValue(o.parameters),adapter:adapterValue(o.adapter),experiment_ids:ids,owner:textValue(o.owner),attempt:versionValue(o.attempt),state,duration_ms:versionValue(o.duration_ms,0),files:filesValue(o.files),...(result?{result}:{}),...(o.manifest_digest?{manifest_digest:digestValue(o.manifest_digest)}:{}),...(o.preparation_contract_digest?{preparation_contract_digest:digestValue(o.preparation_contract_digest)}:{})};
};
export const decodeInstance=(v:unknown):EnvironmentInstance=>{
 const o=object(v,['format','run_id','role','environment','preparation_id','state','attempt','input_digest','validity','release','duration_ms','files'],['execution_id','policy_digest','manifest_digest','session_id','reason']);if(o.format!=='grounds.environment-instance/v1')throw validation('format','invalid instance');
 const role=enumeration(o.role,['answer','grade'],'role');if((role==='grade')!==(o.execution_id!==undefined))throw validation('execution_id','only grade instances bind execution');
 const state=enumeration(o.state,['registered','preparing','prepare_failed','ready','launch_intent','running','collected','unknown','aborted','cancelled'],'state');
 const validity=enumeration(o.validity,['pending','valid','invalid','unknown'],'validity');if(validity==='valid'&&(state!=='collected'||!o.session_id||o.session_id==='unavailable'))throw validation('validity','only collected may be valid');
 if(['ready','launch_intent','running','collected'].includes(state)&&(!o.policy_digest||!o.manifest_digest))throw validation('instance','ready requires policy and manifest');
 return {format:o.format,run_id:idValue(o.run_id),role,environment:environmentRef(o.environment),preparation_id:idValue(o.preparation_id),state,attempt:versionValue(o.attempt,0),input_digest:digestValue(o.input_digest),validity,release:enumeration(o.release,['pending','released','failed'],'release'),duration_ms:versionValue(o.duration_ms,0),files:filesValue(o.files),...(o.execution_id?{execution_id:idValue(o.execution_id)}:{}),...(o.policy_digest?{policy_digest:digestValue(o.policy_digest)}:{}),...(o.manifest_digest?{manifest_digest:digestValue(o.manifest_digest)}:{}),...(o.session_id?{session_id:textValue(o.session_id)}:{}),...(o.reason?{reason:textValue(o.reason)}:{})};
};
export const decodeInstanceReference=(v:unknown):InstanceReference=>{const o=object(v,['instance','preparation']);return {instance:refValue(o.instance),preparation:refValue(o.preparation)};};
export const decodeEnvironmentMetrics=(v:unknown):EnvironmentMetrics=>{
 const o=object(v,['duration_ms','usage','source']);let usage:EnvironmentMetrics['usage']=null;
 if(o.usage!==null){const u=object(o.usage,['input_tokens','output_tokens'],['cached_input_tokens']);usage={input_tokens:versionValue(u.input_tokens,0),output_tokens:versionValue(u.output_tokens,0),...(u.cached_input_tokens!==undefined?{cached_input_tokens:versionValue(u.cached_input_tokens,0)}:{})};if((usage.cached_input_tokens??0)>usage.input_tokens)throw validation('usage','cached tokens are a subset of input');}
 return {duration_ms:versionValue(o.duration_ms,0),usage,source:textValue(o.source)};
};
export async function resolveEnvironment(tx:Pick<ReadTx,'getEvalRecord'>, ref:EnvironmentRef) {
 const record=await tx.getEvalRecord('environment',ref.id,ref.version);if(sha256(record.data)!==ref.digest)throw validation('environment','definition digest mismatch');return record;
}
export function requiredSkills(config:Record<string,unknown>,definition:EnvironmentDefinition,role:'answer'|'grade'):string[]{
 const raw=config.required_skills;if(raw===undefined)return [];const names=list(raw,32).map(skillName);
 if(new Set(names).size!==names.length)throw validation('required_skills','duplicate names');
 if(role==='grade'&&names.length)throw validation('required_skills','grading cannot load tested skills');
 const available=new Set((definition.skills??[]).map(s=>s.name));for(const name of names)if(!available.has(name))throw validation('required_skills',`environment does not declare ${name}`);
 return names;
}
export const unifiedAdapter=(adapter:AdapterIdentity):boolean=>adapter.name==='grounds-env'&&adapter.platform==='docker'&&adapter.version==='1';
export const preparationContractDigest=(definition:EnvironmentDefinition,parameters:Parameters,adapter:AdapterIdentity):string=>sha256({
 script:definition.script,execution:definition.execution,parameters,access:definition.access,skills:definition.skills??[],adapter,
});
export async function validateBinding(tx:Pick<ReadTx,'getEvalRecord'>,b:EnvironmentBinding,role:'answer'|'grade') {
 const env=await resolveEnvironment(tx,b.environment);supportedEnvironment(env.data);if(env.data.role!==role)throw validation('environment','role mismatch');checkParameters(env.data,b.parameters);
 requiredSkills(b.execution_config,env.data,role);
 const check=await tx.getEvalRecord('envcheck',b.validation.id,b.validation.version);
 if(sha256(check.data.environment)!==sha256(b.environment)||!Object.values(check.data.checks).every(Boolean)||!unifiedAdapter(check.data.adapter))throw validation('validation','matching successful unified Docker validation is required');
 return env;
}
export const INSTANCE_TRANSITIONS: Record<InstanceState,InstanceState[]>={registered:['preparing','cancelled'],preparing:['ready','prepare_failed'],prepare_failed:['preparing','cancelled'],ready:['launch_intent','preparing','cancelled'],launch_intent:['running','collected','unknown'],running:['collected','unknown'],collected:[],unknown:['collected','aborted'],aborted:[],cancelled:[]};
