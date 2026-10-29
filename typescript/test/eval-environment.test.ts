import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLStore } from '../src/sql-store.js';
import { EnvironmentModule } from '../src/eval-environment-module.js';
import { decodeEnvironment, decodePreparation, decodePreparationResult, preparationContractDigest } from '../src/eval-environment.js';
import { newUUIDv7 } from '../src/identity.js';
import { sha256, sha256Bytes } from '../src/canonical-json.js';
import { testAgent } from './fixture.js';
import { assertContract } from './schema-fixture.js';
const actor=()=>({operation_id:newUUIDv7(),attribution:testAgent});
const bytes=Buffer.from('[]'), files=new Map([['manifest.json',bytes]]), manifest=[{name:'manifest.json',size:bytes.length,digest:sha256Bytes(bytes)}];
const adapter={name:'grounds-env',version:'1',platform:'docker'};
const definition=(role:string)=>({format:'grounds.eval-environment/v1',name:role,role,task_kind:'qa',parameters:{kb:{type:'string',required:true}},script:{interpreter:'/bin/sh',content:'exit 0'},execution:{backend:'docker',timeout_seconds:60,network_hosts:[]},access:{read_roles:[],kb:false,writable_workspace:false}});
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'grounds-env-')), store=SQLStore.sqlite(join(root,'ledger.db'));await store.initialize('warn');const m=new EnvironmentModule(store),bindings:any={};
 for(const role of ['answer','grade']){const record=await m.publishEnvironment(definition(role),actor()),reference={id:record.id,version:record.version,digest:sha256(record.data)};
  const check=await m.submitCheck({format:'grounds.environment-validation/v1',environment:reference,adapter,parameters:{kb:'test'},checks:{success:true,failure:true,protocol:true,isolation:true},files:manifest},files,actor());
  bindings[role]={environment:reference,validation:{id:check.id,version:1},parameters:{kb:'test'},execution_config:{model:'fixture',enable_kb:false}};
  assertContract('eval.schema.json',{result_type:'patchledger.result.eval/v1',command:'eval.environment.show',payload:record});
 }
 const qa=await m.publishQA({format:'grounds.eval-qa/v1',name:'q',question:'Question?',instructions:'Read',rubric:'Correctness',required_points:[],forbidden_claims:[],references:['fixed'],source:{identity:'q',repository:'fixture',revision:'v1',path:'q',digest:sha256Bytes(bytes),record:{}}},actor());
 const grader=await m.publishGrader({format:'grounds.eval-grader/v1',qa:{id:qa.id,version:1},name:'g',scope:{kind:'diagnostic',name:'quality'},result_spec:{kind:'qa_decision'},definition:{type:'agent',instructions:'grade'},limitations:'test'},actor());
 const suite=await m.createSuite('s',actor()),populated=await m.changeTask(suite.id,1,{type:'add',task:{kind:'qa',name:'q',qa:{id:qa.id,version:1},graders:[{id:grader.id,version:1}]}},actor());
 const experiment=await m.createExperiment({suite_id:suite.id},{name:'env',description:'fixture',environment:bindings},actor());
 const input={experiment_id:experiment.id,task_id:populated.data.tasks[0].id};
 const prepDraft={format:'grounds.environment-preparation/v1',environment:bindings.answer.environment,parameters:{kb:'test'},adapter,experiment_ids:[experiment.id],owner:'fixture',attempt:1,state:'registered',duration_ms:0,files:[]};
 return {m,store,bindings,qa,grader,suite,experiment,input,prepDraft,async close(){await store.close();rmSync(root,{recursive:true,force:true});}};
}
test('environment versions freeze scripts; invalid parameters and unsupported validation cannot enter experiments',async()=>{
 const f=await fixture();try{
  const old=await f.m.show('environment',f.bindings.answer.environment.id,1);
  await f.m.publishEnvironment({...old.data,script:{...old.data.script,content:'exit 1'}},actor(),{id:old.id,expected_version:1});assert.equal((await f.m.show('environment',old.id,1)).data.script.content,'exit 0');
  await assert.rejects(f.m.createExperiment({suite_id:f.suite.id},{name:'bad',description:'bad',environment:{...f.bindings,answer:{...f.bindings.answer,parameters:{unknown:'x'}}}},actor()));
  const coding=await f.m.publishEnvironment({...definition('answer'),execution:{...definition('answer').execution,backend:'macos'}},actor());
  await assert.rejects(f.m.submitCheck({format:'grounds.environment-validation/v1',environment:{id:coding.id,version:1,digest:sha256(coding.data)},adapter,parameters:{kb:'test'},checks:{success:true,failure:true,protocol:true,isolation:true},files:manifest},files,actor()));
  assert.throws(()=>decodeEnvironment({...definition('grade'),access:{read_roles:['code'],kb:false,writable_workspace:false}}));
  assert.throws(()=>decodeEnvironment({...definition('grade'),skills:[{name:'graphkb-cli',entrypoint:'SKILL.md'}]}));
  await assert.rejects(f.m.createExperiment({suite_id:f.suite.id},{name:'missing skill',description:'bad',environment:{...f.bindings,answer:{...f.bindings.answer,execution_config:{...f.bindings.answer.execution_config,required_skills:['graphkb-cli']}}}},actor()));
  assert.throws(()=>decodePreparationResult({format:'grounds.environment-preparation-result/v1',attempt_id:'x',status:'failed',error:{message:'missing stage'}}));
  assert.equal(decodePreparationResult({format:'grounds.environment-preparation-result/v1',attempt_id:'x',status:'success',workspace:{root:'workspace',materials:[]},tools:[],sources:[],skills:[{name:'graphkb-cli',root:'skills/graphkb-cli',entrypoint:'SKILL.md',bundle_digest:sha256([]),file_count:2,total_bytes:100}]}).skills?.[0].name,'graphkb-cli');
  const oversized=(file_count:number,total_bytes:number)=>({format:'grounds.environment-preparation-result/v1',attempt_id:'x',status:'success',workspace:{root:'workspace',materials:[]},tools:[],sources:[],skills:[{name:'graphkb-cli',root:'skills/graphkb-cli',entrypoint:'SKILL.md',bundle_digest:sha256([]),file_count,total_bytes}]});
  assert.throws(()=>decodePreparationResult(oversized(1001,100)));assert.throws(()=>decodePreparationResult(oversized(2,32*1024*1024+1)));
  const historical=decodePreparation(f.prepDraft);assert.equal('preparation_contract_digest' in historical,false);
 }finally{await f.close();}
});
test('preparation contract digest matches the cross-runtime golden vector',()=>{
 const d=decodeEnvironment({...definition('answer'),name:'x',parameters:{n:{type:'number',required:true}},skills:[{name:'graphkb-cli',entrypoint:'SKILL.md'}]});
 assert.equal(preparationContractDigest(d,{n:1.5},adapter),'sha256:751d62051fbda03d0ab700276c67affa1e0f6076087b07363728536159becbca');
});
test('preparation failures persist across explicit retry; targets and evidence cannot be replaced',async()=>{
 const f=await fixture();try{
  const op=actor();let p=await f.m.submitPreparation(f.prepDraft,new Map(),op);assert.equal((await f.m.submitPreparation(f.prepDraft,new Map(),op)).id,p.id);
  p=await f.m.submitPreparation({...p.data,state:'failed',duration_ms:10,files:manifest,result:{format:'grounds.environment-preparation-result/v1',attempt_id:`${p.id}:1`,status:'failed',error:{stage:'clone',message:'unavailable'}}},files,actor(),{id:p.id,expected_version:p.version});
  await assert.rejects(f.m.submitPreparation({...f.prepDraft,parameters:{kb:'different'},attempt:2},new Map(),actor(),{id:p.id,expected_version:p.version}));
  await f.m.submitPreparation({...f.prepDraft,attempt:2},new Map(),actor(),{id:p.id,expected_version:p.version});
  assert.equal((await f.m.show('preparation',p.id,2)).data.result?.status,'failed');assert.equal((await f.m.evidenceFiles('preparation',p.id,2))[0].bytes.toString(),'[]');
 }finally{await f.close();}
});
test('instance transitions bind task and session, preserve DB evidence, and cannot be reused for regrading',async()=>{
 const f=await fixture();try{
  const run=await f.m.startRun(f.input,actor());let prep=await f.m.submitPreparation(f.prepDraft,new Map(),actor());
  prep=await f.m.submitPreparation({...prep.data,state:'success',duration_ms:10,files:manifest,manifest_digest:manifest[0].digest,result:{format:'grounds.environment-preparation-result/v1',attempt_id:`${prep.id}:1`,status:'success',workspace:{root:'workspace',materials:[]},tools:[],sources:[]}},files,actor(),{id:prep.id,expected_version:prep.version});
  const data={format:'grounds.environment-instance/v1',run_id:run.id,role:'answer',environment:f.bindings.answer.environment,preparation_id:prep.id,state:'registered',attempt:0,input_digest:sha256(await f.m.publicContext(run.id)),validity:'pending',release:'pending',duration_ms:0,files:[]};
  let instance=await f.m.submitInstance(data,new Map(),actor());
  await assert.rejects(f.m.submitInstance({...data,state:'collected',validity:'valid',session_id:'impossible',manifest_digest:manifest[0].digest,policy_digest:sha256('p'),files:manifest},files,actor(),{id:instance.id,expected_version:instance.version}));
  for(const state of ['preparing','ready','launch_intent','collected'])instance=await f.m.submitInstance({...instance.data,state,attempt:1,...(state!=='preparing'?{manifest_digest:manifest[0].digest,policy_digest:sha256('policy'),files:manifest}:{}),...(state==='collected'?{validity:'valid',session_id:'session'}:{})},state==='preparing'?new Map():files,actor(),{id:instance.id,expected_version:instance.version});
  const artifact={format:'grounds.eval-artifact/v1',run_id:run.id,qa:{id:f.qa.id,version:1},answer:'Answer',citations:[],execution:{session_id:'session',started_at:'2026-09-22T00:00:00Z',finished_at:'2026-09-22T00:00:01Z',status:'completed',exit_code:0,declared:{},observed:{}},capture:{coverage:'complete',limitations:[]},files:manifest,environment:{instance:{id:instance.id,version:instance.version},preparation:{id:prep.id,version:prep.version}},metrics:{duration_ms:1000,usage:null,source:'fixture'}};
  const frozen=await f.m.submitArtifact(artifact,files,actor());
  await f.m.submitInstance({...instance.data,release:'released'},files,actor(),{id:instance.id,expected_version:instance.version});
  await f.m.submitPreparation({...prep.data,state:'released'},files,actor(),{id:prep.id,expected_version:prep.version});
  await f.m.finishRun(run.id,actor(),'saved for regrade');assert.equal((await f.m.artifactFiles(frozen.id))[0].bytes.toString(),'[]');
  const regrade=await f.m.startRun({...f.input,artifact_id:frozen.id,rerun_of:run.id},actor());
  await assert.rejects(f.m.submitInstance({...data,run_id:regrade.id,input_digest:sha256(await f.m.publicContext(regrade.id))},new Map(),actor()));
  const execution=await f.m.reserveGrader(regrade.id,f.grader.id,actor());assert.equal((await f.m.qaGradingContext(execution.id)).artifact.answer,'Answer');
  assert.equal((await f.store.inspectIntegrity()).report.valid,true);
 }finally{await f.close();}
});

test('shared preparation has compatible consumers, one cost owner, and live-consumer release protection', async () => {
 const f=await fixture();try {
  const peer=await f.m.createExperiment({snapshot_id:f.experiment.data.snapshot_id},{name:'peer',description:'same materials',environment:f.bindings},actor());
  let prep=await f.m.submitPreparation({...f.prepDraft,experiment_ids:[f.experiment.id,peer.id]},new Map(),actor());
  prep=await f.m.submitPreparation({...prep.data,state:'success',duration_ms:42,files:manifest,manifest_digest:manifest[0].digest,result:{format:'grounds.environment-preparation-result/v1',attempt_id:`${prep.id}:1`,status:'success',workspace:{root:'workspace',materials:[]},tools:[],sources:[]}},files,actor(),{id:prep.id,expected_version:prep.version});
  const run=await f.m.startRun({...f.input,experiment_id:peer.id},actor());
  await f.m.submitInstance({format:'grounds.environment-instance/v1',run_id:run.id,role:'answer',environment:f.bindings.answer.environment,preparation_id:prep.id,state:'registered',attempt:0,input_digest:sha256(await f.m.publicContext(run.id)),validity:'pending',release:'pending',duration_ms:0,files:[]},new Map(),actor());
  await assert.rejects(f.m.submitPreparation({...prep.data,state:'released'},files,actor(),{id:prep.id,expected_version:prep.version}));
  const ownerReport=await f.m.report(f.experiment.id), peerReport=await f.m.report(peer.id);
  assert.equal(ownerReport.environment!.owned_preparation_duration_ms,42);
  assert.equal(peerReport.environment!.owned_preparation_duration_ms,0);
  assertContract('eval.schema.json',{result_type:'patchledger.result.eval/v1',command:'eval.experiment.report',payload:ownerReport});
  assertContract('eval.schema.json',{result_type:'patchledger.result.eval/v1',command:'eval.experiment.report',payload:peerReport});
  const incompatible=await f.m.createExperiment({snapshot_id:f.experiment.data.snapshot_id},{name:'other target',description:'cannot share',environment:{...f.bindings,answer:{...f.bindings.answer,parameters:{kb:'other'}}}},actor());
  await assert.rejects(f.m.submitPreparation({...f.prepDraft,experiment_ids:[f.experiment.id,incompatible.id]},new Map(),actor()));
  const withSkill=await f.m.publishEnvironment({...definition('answer'),name:'with-skill',skills:[{name:'graphkb-cli',entrypoint:'SKILL.md'}]},actor());
  const skillRef={id:withSkill.id,version:1,digest:sha256(withSkill.data)};
  const skillCheck=await f.m.submitCheck({format:'grounds.environment-validation/v1',environment:skillRef,adapter,parameters:{kb:'test'},checks:{success:true,failure:true,protocol:true,isolation:true},files:manifest},files,actor());
  const skillBinding={...f.bindings.answer,environment:skillRef,validation:{id:skillCheck.id,version:1},execution_config:{...f.bindings.answer.execution_config,required_skills:['graphkb-cli']}};
  const skillExperiment=await f.m.createExperiment({snapshot_id:f.experiment.data.snapshot_id},{name:'different skill',description:'cannot share',environment:{...f.bindings,answer:skillBinding}},actor());
  await assert.rejects(f.m.submitPreparation({...f.prepDraft,experiment_ids:[f.experiment.id,skillExperiment.id]},new Map(),actor()));
  assert.notEqual(preparationContractDigest(withSkill.data,{kb:'test'},adapter),preparationContractDigest((await f.m.show('environment',f.bindings.answer.environment.id)).data,{kb:'test'},adapter));
 }finally{await f.close();}
});

test('managed regrading accepts unknown historical provenance without creating or blessing an answer instance', async () => {
 const f=await fixture();try {
  const legacy=await f.m.createExperiment({snapshot_id:f.experiment.data.snapshot_id},{name:'legacy',description:'no environment records'},actor());
  const original=await f.m.startRun({...f.input,experiment_id:legacy.id},actor());
  const old=await f.m.submitArtifact({format:'grounds.eval-artifact/v1',run_id:original.id,qa:{id:f.qa.id,version:1},answer:'Answer',citations:[],execution:{session_id:'old',started_at:'2026-09-22T00:00:00Z',finished_at:'2026-09-22T00:00:01Z',status:'completed',exit_code:0,declared:{treatment:'secret label'},observed:{model:'other'}},capture:{coverage:'complete',limitations:[]},files:manifest},files,actor());
  await f.m.finishRun(original.id,actor(),'historical answer');
  const run=await f.m.startRun({...f.input,artifact_id:old.id},actor());
  const execution=await f.m.reserveGrader(run.id,f.grader.id,actor());
  const packet=await f.m.qaGradingContext(execution.id);
  assert.deepEqual(packet.artifact.execution.declared,{});assert.deepEqual(packet.artifact.execution.observed,{});assert.deepEqual(packet.artifact.files,[]);
  let prep=await f.m.submitPreparation({...f.prepDraft,environment:f.bindings.grade.environment},new Map(),actor());
  prep=await f.m.submitPreparation({...prep.data,state:'success',duration_ms:8,files:manifest,manifest_digest:manifest[0].digest,result:{format:'grounds.environment-preparation-result/v1',attempt_id:`${prep.id}:1`,status:'success',workspace:{root:'workspace',materials:[]},tools:[],sources:[]}},files,actor(),{id:prep.id,expected_version:prep.version});
  let instance=await f.m.submitInstance({format:'grounds.environment-instance/v1',run_id:run.id,execution_id:execution.id,role:'grade',environment:f.bindings.grade.environment,preparation_id:prep.id,state:'registered',attempt:0,input_digest:packet.context_digest,validity:'pending',release:'pending',duration_ms:0,files:[]},new Map(),actor());
  for (const state of ['preparing','ready','launch_intent','collected']) instance=await f.m.submitInstance({...instance.data,state,attempt:1,...(state!=='preparing'?{manifest_digest:manifest[0].digest,policy_digest:sha256('policy'),files:manifest}:{}),...(state==='collected'?{session_id:'grade-new',validity:'valid'}:{})},state==='preparing'?new Map():files,actor(),{id:instance.id,expected_version:instance.version});
  await f.m.submitGradingEvidence({format:'grounds.eval-grading-evidence/v1',execution_id:execution.id,context_digest:packet.context_digest,execution:{session_id:'grade-new',started_at:'2026-09-22T00:00:00Z',finished_at:'2026-09-22T00:00:01Z',status:'completed',exit_code:0,declared:{},observed:{}},capture:{coverage:'complete',limitations:[]},files:manifest,environment:{instance:{id:instance.id,version:instance.version},preparation:{id:prep.id,version:prep.version}},metrics:{duration_ms:1000,usage:{input_tokens:10,output_tokens:2},source:'fixture'}},files,actor());
  await f.m.submitGrader({format:'grounds.eval-grader-submission/v1',execution_id:execution.id,context_digest:packet.context_digest,status:'completed',outcome:{kind:'qa_decision',verdict:'pass'},explanation:'checked',evidence:[{kind:'observation',content:'matches'}]},actor());
  const result=await f.m.finishRun(run.id,actor());assert.equal(result.data.answering_duration_ms,undefined);
  const report=await f.m.report(f.experiment.id);assert.equal(report.environment!.answers[0].provenance,'unknown');assert.equal(report.environment!.answers[0].cost_attribution,'original_answer');
  assert.equal(report.environment!.instances.length,1);assert.equal(report.environment!.instances[0].data.role,'grade');
  // Closed runs still accept release diagnostics, without changing execution validity.
  await f.m.submitInstance({...instance.data,release:'released'},files,actor(),{id:instance.id,expected_version:instance.version});
  assert.equal((await f.store.inspectIntegrity()).report.valid,true);
 }finally{await f.close();}
});

test('stopped runs can record uncertain launch termination and release without reopening results', async () => {
 const f=await fixture();try {
  const run=await f.m.startRun(f.input,actor());let prep=await f.m.submitPreparation(f.prepDraft,new Map(),actor());
  prep=await f.m.submitPreparation({...prep.data,state:'success',duration_ms:5,files:manifest,manifest_digest:manifest[0].digest,result:{format:'grounds.environment-preparation-result/v1',attempt_id:`${prep.id}:1`,status:'success',workspace:{root:'workspace',materials:[]},tools:[],sources:[]}},files,actor(),{id:prep.id,expected_version:prep.version});
  let instance=await f.m.submitInstance({format:'grounds.environment-instance/v1',run_id:run.id,role:'answer',environment:f.bindings.answer.environment,preparation_id:prep.id,state:'registered',attempt:0,input_digest:sha256(await f.m.publicContext(run.id)),validity:'pending',release:'pending',duration_ms:0,files:[]},new Map(),actor());
  for(const state of ['preparing','ready','launch_intent'])instance=await f.m.submitInstance({...instance.data,state,attempt:1,...(state!=='preparing'?{manifest_digest:manifest[0].digest,policy_digest:sha256('policy'),files:manifest}:{})},state==='preparing'?new Map():files,actor(),{id:instance.id,expected_version:instance.version});
  const stopped=await f.m.finishRun(run.id,actor(),'interrupted');
  for(const state of ['unknown','aborted'])instance=await f.m.submitInstance({...instance.data,state,validity:'unknown',reason:state==='unknown'?'launch unacknowledged':'process termination verified'},files,actor(),{id:instance.id,expected_version:instance.version});
  instance=await f.m.submitInstance({...instance.data,release:'released'},files,actor(),{id:instance.id,expected_version:instance.version});
  await assert.rejects(f.m.submitInstance({...instance.data,release:'pending'},files,actor(),{id:instance.id,expected_version:instance.version}));
  await f.m.submitPreparation({...prep.data,state:'released'},files,actor(),{id:prep.id,expected_version:prep.version});
  assert.deepEqual(await f.m.show('result',stopped.id),stopped);assert.equal((await f.m.show('run',run.id)).data.state,'closed');
 }finally{await f.close();}
});
