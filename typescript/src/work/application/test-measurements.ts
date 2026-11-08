import { createGrading, digestOf, type DeliveryItem, type JsonValue, type RevisionRef } from "../domain/index.js";
import { GRADING_REQUEST_COUNTER, type WorkRepositories } from "../ports/index.js";
import type { RequestContext } from "./requests.js";
import type { TestGrader } from "./rule-definitions.js";
import { fromRejection, succeed } from "./outcome.js";

export type TestPlan = {
  suite: RevisionRef; caseKey: string; bindingKey: string; runId: string; deliveryId: string;
  commit: string; archiveId:string; receipt: string; repository: string;
};
export type AcceptedTest = {
  gradingId: string; suiteId: string; revisionId: string; caseKey: string; bindingKey: string;
  runId: string; deliveryId: string; status: "accepted";
};

/** A command-based evaluator has its own grading and sandbox. Its plan pins
 * the target and suite revision before a worker can inspect hidden material. */
export async function admitTestMeasurement(ctx: RequestContext, r: WorkRepositories, plan: TestPlan,
  target: DeliveryItem, grader: TestGrader, revision: RevisionRef, materials: {id:string;digest:string}[]) {
  const targetDigest = digestOf({...target}, ctx.hash);
  if (!targetDigest.ok) return fromRejection(targetDigest.error);
  const at = ctx.now(), gradingId = ctx.newId();
  const historical = {taskRunId:plan.runId, suite:plan.suite, caseKey:plan.caseKey, bindingKey:plan.bindingKey};
  const created = createGrading({id:gradingId, purpose:"measure", origin:{type:"standalone", historical},
    graderRevision:revision, grader, requestSeq:await r.sequences.next(GRADING_REQUEST_COUNTER),
    targets:[{type:target.type, id:target.id, digest:targetDigest.value}], materials, at});
  if (!created.ok) return fromRejection(created.error);
  const payload = {...plan, suite:{...plan.suite}} satisfies JsonValue;
  const hash = digestOf(payload, ctx.hash);
  if (!hash.ok) return fromRejection(hash.error);
  await r.gradings.create(created.value.state);
  await r.intents.register({id:ctx.newId(), requestId:"test-grading-" + gradingId, requestHash:hash.value,
    kind:"run-test-grader", subject:{type:"grading_record", id:gradingId}, state:"registered", payload,
    createdAt:at, updatedAt:at, version:1});
  return succeed({gradingId, suiteId:plan.suite.definitionId, revisionId:plan.suite.revisionId,
    caseKey:plan.caseKey, bindingKey:plan.bindingKey, runId:plan.runId, deliveryId:plan.deliveryId, status:"accepted" as const});
}
