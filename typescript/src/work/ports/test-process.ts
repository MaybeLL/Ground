import type { RuntimeLocation, RuntimeOwner, RuntimeWorkspace } from "./sandbox-runtime.js";
export type EvaluatorTarget = {owner:RuntimeOwner;location:RuntimeLocation;containerId:string};
export type StepRead = {state:"running" | "awaiting-resume"} | {state:"stopped";exitCode?:number};
export interface TestProcessPort {
  prepare(owner:RuntimeOwner,target:{commit:string;receipt:string},environment:{config:string;lockfile:string|null;imageDigest:string},
    materials:{path:string;digest:string;base64:string}[]):Promise<RuntimeWorkspace>;
  command(target:EvaluatorTarget,ordinal:number,token:number,argv:string[],allowStart:boolean,cancel:boolean):Promise<StepRead>;
  dispose(owner:RuntimeOwner):Promise<void>;
}
