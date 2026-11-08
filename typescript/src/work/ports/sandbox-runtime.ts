// Sandbox IDs are scoped to a ledger. Only immutable Docker IDs may be used
// for lifecycle operations after verifying both labels.
export type RuntimeOwner = { ledgerId: string; sandboxId: string };
export type RuntimeState = { id: string; state: "running" | "paused" | "stopped" };
export type RuntimeWorkspace = { path: string; configPath: string };
export interface SandboxRuntimePort {
  observe(owner: RuntimeOwner): Promise<RuntimeState | null>;
  up(owner: RuntimeOwner, workspace: RuntimeWorkspace): Promise<RuntimeState>;
  pause(owner: RuntimeOwner, id: string): Promise<void>;
  resume(owner: RuntimeOwner, id: string): Promise<void>;
  remove(owner: RuntimeOwner, id: string): Promise<void>;
  execute(owner: RuntimeOwner, id: string, workspace: RuntimeWorkspace, argv: readonly string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
