import type { EvidenceSource } from "./evidence.js";
import type { RuntimeLocation, RuntimeOwner, RuntimeWorkspace } from "./sandbox-runtime.js";
export type EvaluatorTarget = {owner:RuntimeOwner;location:RuntimeLocation;containerId:string};
export type StepRead = {state:"running" | "awaiting-resume";providerStopped?:boolean} | {state:"stopped";exitCode?:number};
export type TestStreams = Partial<Record<"stdout"|"stderr",{source:EvidenceSource;observedBytes?:number}>>;
export interface TestProcessPort {
  prepare(owner:RuntimeOwner,target:{runId:string;commit:string|null;archiveId:string;receipt:string;repository:string},environment:{config:string;lockfile:string|null;imageDigest:string},
    materials:{path:string;digest:string;base64:string}[]):Promise<RuntimeWorkspace>;
  command(target:EvaluatorTarget,ordinal:number,token:number,argv:string[],allowStart:boolean,cancel:boolean):Promise<StepRead>;
  output(owner:RuntimeOwner,ordinal:number,token:number):Promise<TestStreams>;
  dispose(owner:RuntimeOwner):Promise<void>;
}

/** The immutable evaluator input cannot produce the selected checkout. */
export class TestTargetFault extends Error {}
