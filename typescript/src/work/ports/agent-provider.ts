import type { Capabilities, JsonValue } from "../domain/index.js";

export type ProviderName = "claude-code" | "codex";
export type ProviderEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "message"; role: "assistant"; text: string }
  | { kind: "tool-call"; callId: string; tool: string; input?: JsonValue }
  | { kind: "tool-result"; callId: string; output?: JsonValue; failed?: boolean }
  | { kind: "error"; message: string }
  | { kind: "provider-ended"; outcome: "succeeded" | "failed" };

/** A source record can produce several events. Unrecognized records are kept
 * in the raw trajectory; they do not imply any execution state transition. */
export interface AgentProvider {
  readonly name: ProviderName;
  readonly capabilities: Capabilities;
  command(model?: string): readonly string[];
  events(record: JsonValue): ProviderEvent[];
}

export type ProviderTrace = import("../domain/index.js").FrozenTrace;
export interface CapturedTrace {
  descriptor: ProviderTrace;
  raw: import("./evidence.js").EvidenceSource;
  events: import("./evidence.js").EvidenceSource;
  dispose(): Promise<void>;
}
export interface TraceCapturePort {
  capture(provider: ProviderName, file: string): Promise<CapturedTrace>;
}
