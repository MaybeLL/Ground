import { createGrading, digestOf, type DeliveryItem, type GradingOrigin, type JsonValue, type RevisionRef } from "../domain/index.js";
import { GRADING_REQUEST_COUNTER, type WorkRepositories } from "../ports/index.js";
import type { RequestContext } from "./requests.js";
import type { AgentGrader,TestGrader } from "./rule-definitions.js";
import { fromRejection, succeed } from "./outcome.js";

export type TestPlan = {
  suite: RevisionRef; caseKey: string; bindingKey: string; runId: string; deliveryId: string;
  commit: string|null; archiveId:string; receipt: string; originalReceipt?: string; repository: string;
};
export type AcceptedTest = {
  gradingId: string; suiteId: string; revisionId: string; caseKey: string; bindingKey: string;
  runId: string; deliveryId: string; status: "accepted";
};

/** A command-based evaluator has its own grading and sandbox. Its plan pins
 * the target and suite revision before a worker can inspect hidden material. */
export async function admitTestMeasurement(ctx: RequestContext, r: WorkRepositories, plan: TestPlan,
  target: DeliveryItem, grader: TestGrader|AgentGrader, revision: RevisionRef, materials: {id:string;digest:string}[], origin?:GradingOrigin) {
  const targetDigest = digestOf({...target}, ctx.hash);
  if (!targetDigest.ok) return fromRejection(targetDigest.error);
  const at = ctx.now(), gradingId = ctx.newId();
  const historical = {taskRunId:plan.runId, suite:plan.suite, caseKey:plan.caseKey, bindingKey:plan.bindingKey};
  const created = createGrading({id:gradingId, purpose:"measure", origin:origin ?? {type:"standalone", historical},
    graderRevision:revision, grader, requestSeq:await r.sequences.next(GRADING_REQUEST_COUNTER),
    targets:[{type:target.type, id:target.id, digest:targetDigest.value}], materials, at});
  if (!created.ok) return fromRejection(created.error);
  const payload = {...plan, originalReceipt:target.receipt, suite:{...plan.suite}} satisfies JsonValue;
  const hash = digestOf(payload, ctx.hash);
  if (!hash.ok) return fromRejection(hash.error);
  await r.gradings.create(created.value.state);
  await r.intents.register({id:ctx.newId(), requestId:"test-grading-" + gradingId, requestHash:hash.value,
    kind:grader.strategy==="agent" ? "run-agent-grader" : "run-test-grader", subject:{type:"grading_record", id:gradingId}, state:"registered", payload,
    createdAt:at, updatedAt:at, version:1});
  if (origin?.type === "member") await markGradingActive(r,origin.experimentRunId,at);
  return succeed({gradingId, suiteId:plan.suite.definitionId, revisionId:plan.suite.revisionId,
    caseKey:plan.caseKey, bindingKey:plan.bindingKey, runId:plan.runId, deliveryId:plan.deliveryId, status:"accepted" as const});
}


/** Called under the batch lock while admitting a supplementary grading. */
export async function markGradingActive(r:WorkRepositories,batchId:string,at:string) {
  const [driver] = await r.intents.listForSubject("drive-experiment","experiment_run",batchId);
  if (driver?.state !== "completed") return;
  const payload = driver.payload as {batchId:string;firstTerminalAt?:string};
  await r.intents.save({...driver,state:"registered",payload:{...payload,observation:{state:"running",detail:"member regrading is active"}},
    updatedAt:at,version:driver.version+1},driver.version);
}
