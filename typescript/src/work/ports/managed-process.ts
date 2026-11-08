import type { AgentSettings, ManagedTask } from "../domain/managed.js";
import type { CapturedTrace } from "./agent-provider.js";
import type { EvidenceSource } from "./evidence.js";
import type { RuntimeOwner, RuntimeLocation } from "./sandbox-runtime.js";

export type WorkerTarget = {containerId:string;location:RuntimeLocation;owner:RuntimeOwner};
export type ProcessPlan = {job:ManagedTask;target:WorkerTarget;agent:AgentSettings;prompt:string};
export type ProcessRead = {state:"complete";exitCode:number} | {state:"running"|"awaiting-resume"|"interrupted";detail:string};
export type WorkerOutput = {trace:CapturedTrace;output:EvidenceSource;stderr:EvidenceSource;message:string;providerFailed:boolean};
export type CapturedArtifacts = {entries:{slot:string;files:{path:string;source:EvidenceSource}[]}[];dispose():Promise<void>};
export interface ManagedProcessPort {
  artifacts(plan:ProcessPlan,declared:readonly import("../domain/managed-delivery.js").ArtifactDeclaration[]):Promise<CapturedArtifacts>;
  handle(plan:ProcessPlan,allowCreate:boolean):Promise<string|undefined>;
  drive(plan:ProcessPlan,handle:string,allowStart:boolean):Promise<ProcessRead>;
  output(plan:ProcessPlan):Promise<WorkerOutput>;
  exportCandidate(plan: ProcessPlan, commit: string, allowStart: boolean): Promise<"ready" | "invalid" | "running" | "awaiting-resume" | "interrupted">;
  candidate(plan:ProcessPlan,commit:string,baseline:string,remote:string,allowPublish:boolean):Promise<{status:"confirmed";id:string;receipt:string}|{status:"invalid"|"unavailable";reason:string}>;
  quiescent(plan:ProcessPlan):Promise<boolean>;
  stop(plan:ProcessPlan,force:boolean):Promise<void>;
}
