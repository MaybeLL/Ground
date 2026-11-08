import {BUILTIN_VERIFICATION_GRADER} from "./builtin-grader.js";
import {once,type RequestContext} from "./requests.js";
import {fail,succeed} from "./outcome.js";
import {digestOf,isGradingTerminal,isText,refOf,sameRef,type JsonValue,type DeliveryItem,type GradingRecord,type Grade,type CriterionVerdict,type RevisionRef} from "../domain/index.js";
import type {WorkRepositories} from "../ports/index.js";
import {agentGrader} from "./rule-definitions.js";

export type GateJudge = {strategy:"agent";protocol:"independent";agent:RevisionRef;environment:RevisionRef;environmentRevisionId:string;scale:{form:"criteria"}};
export type ManagedGatePlan = {runId:string;repository:string;items:DeliveryItem[];judge:GateJudge};
type Selection={requestId:string;gradingId:string;agentId:string;agentRevisionId:string;environmentId:string;environmentRevisionId:string;repository:string};

export async function selectManagedGate(ctx:RequestContext,input:Selection) {
  return once(ctx,{requestId:input.requestId,kind:"select-managed-gate",input,subject:{type:"grading_record",id:input.gradingId}},async r=>{
    const g=await r.gradings.get(input.gradingId,{lock:true});
    if (!g || g.origin.type!=="gate" || g.graderRevision.revisionId!==BUILTIN_VERIFICATION_GRADER.revisionId || !g.binding) return fail("invalid","select a built-in verification gate");
    if (isGradingTerminal(g) || g.cancelIntent || g.evaluator) return fail("conflict","this gate cannot take a managed evaluator");
    const run=await r.taskRuns.get(g.origin.taskRunId);
    if (!run?.manifest || run.manifest.digest!==g.binding.manifestDigest) return fail("conflict","frozen gate delivery changed");
    const agent=await r.definitions.getRevision(input.agentId,input.agentRevisionId);
    const env=await r.definitions.getRevision(input.environmentId,input.environmentRevisionId);
    if (agent?.kind!=="agent" || env?.kind!=="environment") return fail("invalid","select published agent and environment revisions");
    const [prior]=await r.intents.listForSubject("run-agent-grader","grading_record",g.id);
    if (prior) return fail("conflict","a managed evaluator was already selected");
    const judge:GateJudge={protocol:"independent",strategy:"agent",agent:refOf(agent),environment:refOf(env),environmentRevisionId:env.id,scale:{form:"criteria"}};
    const plan:ManagedGatePlan={runId:run.id,repository:input.repository,items:run.manifest.items.map(i=>({...i})),judge};
    const at=ctx.now();
    const hash=digestOf(plan as unknown as JsonValue,ctx.hash);
    if (!hash.ok) return fail("invalid",hash.error.message);
    await r.intents.register({kind:"run-agent-grader",id:ctx.newId(),requestId:"test-grading-"+g.id,subject:{type:"grading_record",id:g.id},
      requestHash:hash.value,payload:plan as unknown as JsonValue,state:"registered",createdAt:at,updatedAt:at,version:1});
    return succeed({gradingId:g.id,runId:run.id,status:"accepted" as const});
  });
}

export async function configuredJudge(r:WorkRepositories,g:GradingRecord) {
  if (g.purpose==="gate") {
    const [job]=await r.intents.listForSubject("run-agent-grader","grading_record",g.id);
    const judge=(job?.payload as unknown as ManagedGatePlan|undefined)?.judge;
    if (!judge || judge.protocol!=="independent" || g.graderRevision.revisionId!==BUILTIN_VERIFICATION_GRADER.revisionId) return;
    const env=await r.definitions.getRevision(judge.environment.definitionId,judge.environment.revisionId);
    if (env?.kind!=="environment" || !sameRef(refOf(env),judge.environment)) return;
    return judge;
  }
  const revision=await r.definitions.getRevision(g.graderRevision.definitionId,g.graderRevision.revisionId);
  return revision && agentGrader(revision.content);
}

export type BlindFinding={criterionId:string;independent:"satisfied"|"unsatisfied"|"indeterminate";rationale:string;evidence:string[]};
export function blindFindings(message:string|undefined,expected:readonly string[]):BlindFinding[]|undefined {
  let items;
  try {items=JSON.parse(message ?? "").findings;} catch {return;}
  if (!Array.isArray(items) || items.length!==expected.length) return;
  const remaining=new Set(expected);
  const findings:BlindFinding[]=[];
  for (const item of items) {
    if (!item || !remaining.delete(item.criterionId) || !["satisfied","unsatisfied","indeterminate"].includes(item.independent) ||
        !isText(item.rationale,4096) || !Array.isArray(item.evidence) || !item.evidence.every((v:unknown)=>isText(v,4096))) return;
    findings.push({criterionId:item.criterionId,independent:item.independent,rationale:item.rationale,evidence:item.evidence});
  }
  return findings;
}


// Provider output is untrusted JSON. Keep only fields declared by the public
// grade contract; validateGradingSubmission checks values and provenance.
export function gateVerdict(message:string|undefined,findings:readonly BlindFinding[]):Grade|undefined {
  let grade;
  try {grade=JSON.parse(message ?? "").grade;} catch {return;}
  if (grade?.form!=="criteria" || !Array.isArray(grade.items) || grade.items.length!==findings.length) return;
  const independent=new Map(findings.map(f=>[f.criterionId,f.independent]));
  const items:CriterionVerdict[]=[];
  for (const item of grade.items) {
    if (!item || !independent.has(item.criterionId) || independent.get(item.criterionId)!==item.independent ||
        !Array.isArray(item.evidence) || !item.evidence.every((v:unknown)=>typeof v==="string")) return;
    const {criterionId,independent:blind,reconciliation,final,rationale,evidence,reusedFrom}=item;
    items.push({criterionId,independent:blind,reconciliation,final,rationale,evidence,...(reusedFrom===undefined ? {} : {reusedFrom})});
  }
  return {form:"criteria",items};
}
