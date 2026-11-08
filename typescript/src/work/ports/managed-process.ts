import type { AgentSettings, ManagedTask } from "../domain/managed.js";
import type { CapturedTrace } from "./agent-provider.js";
import type { EvidenceSource } from "./evidence.js";
import type { RuntimeOwner, RuntimeLocation } from "./sandbox-runtime.js";

export type WorkerTarget = {containerId:string;location:RuntimeLocation;owner:RuntimeOwner};
export type AgentProcessPlan = {job:{executionId:string};target:WorkerTarget;agent:AgentSettings;role?:"evaluator";prompt:string};
export type ProcessPlan = AgentProcessPlan & {job:ManagedTask};
export type ProcessRead = {state:"complete";exitCode:number} | {state:"running"|"awaiting-resume"|"interrupted";detail:string};
export type WorkerOutput = {trace:CapturedTrace;output:EvidenceSource;stderr:EvidenceSource;message:string;providerFailed:boolean};
export type CapturedArtifacts = {entries:{slot:string;files:{path:string;source:EvidenceSource}[]}[];dispose():Promise<void>};
export type GateAuthorMaterials = {
  manifest:{digest:string;origin:string;items:{id:string;type:string;path:string}[];trajectoryReceipt?:string};
  materials:readonly {id:string;digest:string;file?:string;source?:EvidenceSource}[];
};
export interface ManagedProcessPort {
  revealGate(target:WorkerTarget,author:GateAuthorMaterials):Promise<void>;
  artifacts(plan:ProcessPlan,declared:readonly import("../domain/managed-delivery.js").ArtifactDeclaration[]):Promise<CapturedArtifacts>;
  handle(plan:AgentProcessPlan,allowCreate:boolean):Promise<string|undefined>;
  drive(plan:AgentProcessPlan,handle:string,allowStart:boolean,authorizeStart?:()=>Promise<boolean>):Promise<ProcessRead>;
  availableOutput(plan:AgentProcessPlan):Promise<Partial<WorkerOutput>|undefined>;
  output(plan:AgentProcessPlan):Promise<WorkerOutput>;
  exportCandidate(plan: ProcessPlan, commit: string, allowStart: boolean): Promise<"ready" | "invalid" | "running" | "awaiting-resume" | "interrupted">;
  candidate(plan:ProcessPlan,commit:string,baseline:string,remote:string,allowPublish:boolean):Promise<{status:"confirmed";id:string;receipt:string}|{status:"invalid"|"unavailable";reason:string}>;
  quiescent(plan:AgentProcessPlan):Promise<boolean>;
  stop(plan:AgentProcessPlan,force:boolean):Promise<void>;
}
