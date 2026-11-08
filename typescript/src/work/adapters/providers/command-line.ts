import type { JsonValue } from "../../domain/index.js";
import type { AgentProvider, ProviderEvent, ProviderName } from "../../ports/index.js";

type ObjectValue = { [key: string]: JsonValue };
const object = (v: JsonValue | undefined): ObjectValue | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v : undefined;
const capabilities = { resume: false, verifiableStop: false, events: "partial" } as const;

export const codexProvider: AgentProvider = {
  name: "codex", capabilities,
  // The prompt is read from standard input. The container is the workspace
  // boundary; workspace-write applies the provider's own filesystem policy.
  command: model => ["codex","exec","--json","--ephemeral","--sandbox","workspace-write",...(model ? ["--model",model] : []),"-"],
  decode(record) {
    const events = this.events(record).map(event => ({part:0,event}));
    return {events,unknownParts:events.length ? 0 : 1};
  },
  events(value) {
    const row = object(value);
    if (!row) return [];
    if (row.type === "thread.started" && typeof row.thread_id === "string") return [{kind:"session",sessionId:row.thread_id}];
    if (row.type === "turn.completed") return [{kind:"provider-ended",outcome:"succeeded"}];
    if (row.type === "turn.failed" || row.type === "error") {
      const message = object(row.error)?.message ?? row.message;
      const events: ProviderEvent[] = typeof message === "string" ? [{kind:"error",message}] : [];
      if (row.type === "turn.failed") events.push({kind:"provider-ended",outcome:"failed"});
      return events;
    }
    const item = object(row.item);
    if (!item || typeof item.id !== "string") return [];
    if (row.type === "item.completed" && item.type === "agent_message" && typeof item.text === "string") return [{kind:"message",role:"assistant",text:item.text}];
    if (item.type !== "command_execution" && item.type !== "mcp_tool_call") return [];
    const tool = item.type === "command_execution" ? "shell" : typeof item.tool === "string" ? item.tool : "mcp";
    if (row.type === "item.started") return [{kind:"tool-call",callId:item.id,tool,...(item.command !== undefined ? {input:item.command} : item.arguments !== undefined ? {input:item.arguments} : {})}];
    if (row.type === "item.completed") {
      const output = item.aggregated_output ?? item.result ?? item.error;
      return [{kind:"tool-result",callId:item.id,...(output !== undefined ? {output} : {}),
        ...(typeof item.exit_code === "number" ? {failed:item.exit_code !== 0} : item.status === "failed" ? {failed:true} : {})}];
    }
    return [];
  },
};

export const claudeCodeProvider: AgentProvider = {
  name: "claude-code", capabilities,
  command: model => ["claude","-p","--verbose","--output-format","stream-json","--no-session-persistence","--permission-mode","acceptEdits",...(model ? ["--model",model] : [])],
  decode(record) {
    const row = object(record), message = object(row?.message);
    if (!row || !Array.isArray(message?.content) || (row.type !== "assistant" && row.type !== "user")) {
      const events = this.events(record).map(event=>({part:0,event}));
      return { events, unknownParts:events.length ? 0 : 1 };
    }
    const events: {part:number;event:ProviderEvent}[] = [];
    let unknownParts = 0;
    for (const [part,block] of message.content.entries()) {
      const mapped = this.events({...row,message:{...message,content:[block]}});
      if (!mapped.length) unknownParts++;
      for (const event of mapped) events.push({part,event});
    }
    return {events,unknownParts};
  },
  events(value) {
    const row = object(value);
    if (!row) return [];
    if (row.type === "system" && row.subtype === "init" && typeof row.session_id === "string") return [{kind:"session",sessionId:row.session_id}];
    if (row.type === "result") {
      const failed = row.is_error === true || (typeof row.subtype === "string" && row.subtype.startsWith("error"));
      if (!failed && row.subtype !== "success") return [];
      const events: ProviderEvent[] = [];
      if (failed && typeof row.result === "string") events.push({kind:"error",message:row.result});
      events.push({kind:"provider-ended",outcome:failed ? "failed" : "succeeded"});
      return events;
    }
    const content = object(row.message)?.content;
    if (!Array.isArray(content) || (row.type !== "assistant" && row.type !== "user")) return [];
    const events: ProviderEvent[] = [];
    for (const part of content) {
      const block = object(part);
      if (!block) continue;
      if (row.type === "assistant" && block.type === "text" && typeof block.text === "string") events.push({kind:"message",role:"assistant",text:block.text});
      if (row.type === "assistant" && block.type === "tool_use" && typeof block.name === "string" && typeof block.id === "string") {
        events.push({kind:"tool-call",callId:block.id,tool:block.name,...(block.input !== undefined ? {input:block.input} : {})});
      }
      if (row.type === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
        events.push({kind:"tool-result",callId:block.tool_use_id,...(block.content !== undefined ? {output:block.content} : {}),...(typeof block.is_error === "boolean" ? {failed:block.is_error} : {})});
      }
    }
    return events;
  },
};

export const commandLineProviders: Record<ProviderName,AgentProvider> = {codex:codexProvider,"claude-code":claudeCodeProvider};
