// Sandbox IDs are scoped to a ledger. Only immutable Docker IDs may be used
// for lifecycle operations after verifying both labels.
export type RuntimeLocation = { hostId: string; daemonId: string };
export type RuntimeOwner = { ledgerId: string; sandboxId: string; setupAttempt?: string };
export type RuntimeState = { id: string; setupAttempt?: string; state: "running" | "paused" | "stopped" };
export type RuntimeWorkspace = { path: string; graderMaterials?: string; evaluatorDelivery?:string; taskMaterials?:string; configPath: string; containerFolder?: string; imageDigest?: string; frozenLockfile?: boolean };
export interface SandboxRuntimePort {
  location(): Promise<RuntimeLocation>;
  exclusive<T>(owner: RuntimeOwner, fn: () => Promise<T>): Promise<T>;
  observe(owner: RuntimeOwner): Promise<RuntimeState | null>;
  up(owner: RuntimeOwner, workspace: RuntimeWorkspace): Promise<RuntimeState>;
  stop(owner: RuntimeOwner, id: string): Promise<void>;
  pause(owner: RuntimeOwner, id: string): Promise<void>;
  resume(owner: RuntimeOwner, id: string): Promise<void>;
  remove(owner: RuntimeOwner, id: string): Promise<void>;
  externalCommand(owner:RuntimeOwner,id:string,workspace:RuntimeWorkspace):Promise<string[]>;
  execute(owner: RuntimeOwner, id: string, workspace: RuntimeWorkspace, argv: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** The configuration and completion evidence live outside the worker's mount. */
export interface ManagedWorkspacePort {
  prepare(owner: RuntimeOwner, repository: string, commit: string|null, content: { config: string; lockfile: string | null; imageDigest: string }, requireExisting?: boolean,repositories?:readonly import("../domain/definitions.js").MaterialRepository[]): Promise<RuntimeWorkspace>;
  prepareExternal(owner:RuntimeOwner,runId:string,repository:string,commit:string|null,content:{config:string;lockfile:string|null;imageDigest:string},select:()=>Promise<{path:string;materials?:readonly {path:string}[]}>,repositories:readonly import("../domain/definitions.js").MaterialRepository[]):Promise<RuntimeWorkspace>;
  receipt(owner: RuntimeOwner): Promise<string | null>;
  record(owner: RuntimeOwner, containerId: string): Promise<void>;
}

export type LaunchObservation = "not-started" | "active" | "failed" | "completed" | "interrupted";
/** The launch helper survives the client and owns the lock until its tool exits. */
export interface SandboxLauncher {
  dispatched?(owner:RuntimeOwner):boolean;
  workspace(owner:RuntimeOwner,location:RuntimeLocation,expectedPath:string):Promise<RuntimeWorkspace>;
  start(owner: RuntimeOwner, workspace: RuntimeWorkspace, location: RuntimeLocation): Promise<void>;
  status(owner: RuntimeOwner): Promise<LaunchObservation>;
  cancelPending(owner: RuntimeOwner): Promise<boolean>;
}
