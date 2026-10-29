import { EvalModule, type EvalWrite } from './eval-module.js';
import { unifiedAdapter, decodeEnvironment, decodeEnvironmentCheck, decodePreparation, decodeInstance, resolveEnvironment, checkParameters, supportedEnvironment, validateBinding, preparationContractDigest, INSTANCE_TRANSITIONS, type EvidenceFile } from './eval-environment.js';
import { idValue, versionValue, type EvalRecord } from './evaluation.js';
import { sha256, sha256Bytes } from './canonical-json.js';
import { validation, versionConflict } from './errors.js';
import type { Tx } from './store-types.js';

export class EnvironmentModule extends EvalModule {
  private async evidence(tx: Tx, manifest: EvidenceFile[], files: Map<string,Buffer>) {
    if(files.size!==manifest.length) throw validation('files','must match manifest');
    for(const f of manifest) { const bytes=files.get(f.name);if(!bytes||bytes.length!==f.size||sha256Bytes(bytes)!==f.digest)throw validation('files','evidence digest or size mismatch');await tx.putEvalBlob(bytes); }
  }
  async evidenceFiles(kind:'envcheck'|'preparation'|'instance',id:string,version?:number) {
    return this.store.read(async tx=>{const r=await tx.getEvalRecord(kind,id,version);return Promise.all(r.data.files.map(async f=>({...f,bytes:await tx.getEvalBlob(f.digest)})));});
  }
  publishEnvironment(raw:unknown,actor:EvalWrite,update?:{id:string;expected_version:number}):Promise<EvalRecord<'environment'>> {
    const draft=decodeEnvironment(raw);if(update){idValue(update.id);versionValue(update.expected_version);}
    return this.write('environment.publish',{draft,...(update?{update}:{})},actor,async tx=>{
      const old=update?await tx.getEvalRecord('environment',update.id):undefined;
      if(old&&old.version!==update!.expected_version)throw versionConflict('eval_environment',old.id,update!.expected_version,old.version);
      return this.save(tx,'environment',draft,actor,old);
    });
  }
  submitCheck(raw:unknown,files:Map<string,Buffer>,actor:EvalWrite):Promise<EvalRecord<'envcheck'>> {
    const draft=decodeEnvironmentCheck(raw);
    return this.write('envcheck.submit',draft,actor,async tx=>{
      const env=await resolveEnvironment(tx,draft.environment);checkParameters(env.data,draft.parameters);
      if(Object.values(draft.checks).every(Boolean)){supportedEnvironment(env.data);if(!unifiedAdapter(draft.adapter))throw validation('adapter','unsupported adapter');}
      if(!draft.files.length)throw validation('files','validation requires evidence');await this.evidence(tx,draft.files,files);
      return this.save(tx,'envcheck',draft,actor,undefined,env.id);
    });
  }
  submitPreparation(raw:unknown,files:Map<string,Buffer>,actor:EvalWrite,update?:{id:string;expected_version:number}):Promise<EvalRecord<'preparation'>> {
    const draft=decodePreparation(raw);
    if(!unifiedAdapter(draft.adapter)) throw validation('adapter','historical preparations are read-only; use the unified Docker environment');
    return this.write('preparation.submit',{draft,...(update?{update}:{})},actor,async tx=>{
      const env=await resolveEnvironment(tx,draft.environment);supportedEnvironment(env.data);checkParameters(env.data,draft.parameters);
      const expectedContract=preparationContractDigest(env.data,draft.parameters,draft.adapter);
      if(draft.preparation_contract_digest&&draft.preparation_contract_digest!==expectedContract)throw validation('preparation_contract_digest','does not match environment, parameters, and adapter');
      for(const id of draft.experiment_ids){
        const e=await tx.getEvalRecord('experiment',id);const binding=e.data.environment?.[env.data.role];if(!binding)throw validation('experiment','requires environment mode');
        const target=await validateBinding(tx,binding,env.data.role);const check=await tx.getEvalRecord('envcheck',binding.validation.id,binding.validation.version);
        if(preparationContractDigest(target.data,binding.parameters,check.data.adapter)!==expectedContract)throw validation('preparation','incompatible shared preparation contract');
      }
      const old=update?await tx.getEvalRecord('preparation',update.id):undefined;
      const candidate=old?.data.preparation_contract_digest&&!draft.preparation_contract_digest?{...draft,preparation_contract_digest:old.data.preparation_contract_digest}:draft;
      if(old){
        if(old.version!==update!.expected_version)throw versionConflict('eval_preparation',old.id,update!.expected_version,old.version);
        const frozen=(d:typeof draft)=>({environment:d.environment,parameters:d.parameters,adapter:d.adapter,experiment_ids:d.experiment_ids,owner:d.owner,preparation_contract_digest:d.preparation_contract_digest??null});
        if(sha256(frozen(old.data))!==sha256(frozen(candidate)))throw validation('preparation','immutable ownership and inputs');
        if(old.data.state==='released')throw validation('state','already released');
        const retry=old.data.state==='failed'&&candidate.state==='registered'&&candidate.attempt===old.data.attempt+1;
        const finish=old.data.state==='registered'&&['success','failed'].includes(candidate.state)&&candidate.attempt===old.data.attempt;
        const release=['success','failed'].includes(old.data.state)&&candidate.state==='released'&&candidate.attempt===old.data.attempt;
        if(!retry&&!finish&&!release)throw validation('state','invalid preparation transition');
        if(release&&sha256({...old.data,state:'released'})!==sha256(candidate))throw validation('release','cannot replace preparation evidence on release');
        if(release){const instances=await tx.listEvalRecords('instance');if(instances.some(i=>i.data.preparation_id===old.id&&i.data.release!=='released'))throw validation('release','instances still own preparation');}
      }else if(draft.state!=='registered'||draft.attempt!==1)throw validation('state','register preparation before execution');
      if(candidate.result&&candidate.result.attempt_id!==`${old!.id}:${candidate.attempt}`)throw validation('attempt_id','must bind preparation ID and attempt');
      if(candidate.result?.status==='success'){
        const declared=(env.data.skills??[]).map(s=>`${s.name}:${s.entrypoint}`).sort();const prepared=(candidate.result.skills??[]).map(s=>`${s.name}:${s.entrypoint}`).sort();
        if(sha256(declared)!==sha256(prepared))throw validation('skills','prepared skills must exactly match the environment definition');
      }
      if(candidate.state==='success'&&!candidate.files.some(f=>f.digest===candidate.manifest_digest))throw validation('manifest','persist workspace manifest bytes');
      const persisted=!old?{...candidate,preparation_contract_digest:expectedContract}:candidate;
      await this.evidence(tx,persisted.files,files);return this.save(tx,'preparation',persisted,actor,old);
    });
  }
  submitInstance(raw:unknown,files:Map<string,Buffer>,actor:EvalWrite,update?:{id:string;expected_version:number}):Promise<EvalRecord<'instance'>> {
    const draft=decodeInstance(raw);
    return this.write('instance.submit',{draft,...(update?{update}:{})},actor,async tx=>{
      const run=await tx.getEvalRecord('run',draft.run_id);const experiment=await tx.getEvalRecord('experiment',run.data.experiment_id);const binding=experiment.data.environment?.[draft.role];
      if(!binding||sha256(binding.environment)!==sha256(draft.environment))throw validation('environment','instance must inherit experiment binding');
      const boundEnvironment=await validateBinding(tx,binding,draft.role);
      const prep=await tx.getEvalRecord('preparation',draft.preparation_id);if(!prep.data.experiment_ids.includes(experiment.id))throw validation('preparation','not a consumer');
      const prepEnvironment=await resolveEnvironment(tx,prep.data.environment);
      if(prepEnvironment.data.role!==draft.role||sha256(prep.data.parameters)!==sha256(binding.parameters))throw validation('preparation','wrong role or semantic parameters');
      if(prep.data.preparation_contract_digest){const check=await tx.getEvalRecord('envcheck',binding.validation.id,binding.validation.version);if(prep.data.preparation_contract_digest!==preparationContractDigest(boundEnvironment.data,binding.parameters,check.data.adapter))throw validation('preparation','shared preparation contract differs from binding');}
      if(draft.role==='answer'&&run.data.mode!=='answer')throw validation('role','regrading never creates answer instance');
      let inputDigest:string;
      if(draft.execution_id){const execution=await tx.getEvalRecord('execution',draft.execution_id);if(execution.data.run_id!==run.id)throw validation('execution','wrong run');inputDigest=execution.data.context_digest;}
      else {const q=await tx.getEvalRecord('qa',run.data.task.qa!.id,run.data.task.qa!.version);inputDigest=sha256({format:'grounds.eval-public-task/v1',run_id:run.id,qa:run.data.task.qa,question:q.data.question,instructions:q.data.instructions});}
      if(inputDigest!==draft.input_digest)throw validation('input_digest','wrong task or grading packet');
      const old=update?await tx.getEvalRecord('instance',update.id):undefined;
      if(old){
        if(old.version!==update!.expected_version)throw versionConflict('eval_instance',old.id,update!.expected_version,old.version);
        const fixed=(d:typeof draft)=>({run_id:d.run_id,execution_id:d.execution_id??null,role:d.role,environment:d.environment,preparation_id:d.preparation_id,input_digest:d.input_digest});
        if(sha256(fixed(old.data))!==sha256(fixed(draft)))throw validation('instance','immutable binding');
        if(old.data.release==='released')throw validation('release','released instances cannot execute or change again');
        const releaseOnly=old.data.state===draft.state&&old.data.release!==draft.release;
        if(releaseOnly&&draft.release==='pending')throw validation('release','cannot reopen released resources');
        if(!releaseOnly&&!INSTANCE_TRANSITIONS[old.data.state].includes(draft.state))throw validation('state','invalid instance transition');
        const executionFacts=(d:typeof draft)=>{const {release,reason,files,...facts}=d;return facts;};
        if(releaseOnly&&sha256(executionFacts(old.data))!==sha256(executionFacts(draft)))throw validation('release','cannot change execution facts');
        const expectedAttempt=old.data.attempt+(draft.state==='preparing'?1:0);if(draft.attempt!==expectedAttempt)throw validation('attempt','wrong preparation attempt');
        if(['launch_intent','running','collected','unknown','aborted'].includes(old.data.state)&&old.data.policy_digest!==draft.policy_digest)throw validation('policy','cannot change after launch');
        if(run.data.state==='closed'&&!releaseOnly&&!['prepare_failed','unknown','aborted','cancelled'].includes(draft.state))throw validation('run','closed run accepts only termination and release diagnostics');
      }else{
        if(run.data.state!=='open'||draft.state!=='registered'||draft.attempt!==0)throw validation('state','register instance first');
        const existing=await tx.listEvalRecords('instance',run.id);if(existing.some(i=>i.data.role===draft.role&&i.data.execution_id===draft.execution_id))throw validation('instance','session already has an instance');
      }
      if(['ready','launch_intent','running','collected'].includes(draft.state)&&prep.data.state!=='success')throw validation('preparation','requires successful shared preparation');
      if(['ready','collected'].includes(draft.state)&&!draft.files.some(f=>f.digest===draft.manifest_digest))throw validation('manifest','persist initial manifest evidence');
      if(draft.release!=='pending'&&!['registered','prepare_failed','collected','aborted','cancelled'].includes(draft.state))throw validation('release','cannot release live or uncertain session');
      if(draft.validity!=='pending'&&draft.validity!=='valid'&&!draft.reason)throw validation('reason','invalid or unknown requires diagnostics');
      if(draft.session_id){const others=await tx.listEvalRecords('instance');if(others.some(i=>i.id!==old?.id&&i.data.session_id===draft.session_id))throw validation('session','already bound');}
      await this.evidence(tx,draft.files,files);return this.save(tx,'instance',draft,actor,old,run.id);
    });
  }
}
