export type AgentSettings = {provider:"codex"|"claude-code";model?:string};
export type ManagedTask = {runId:string;executionId:string;repositoryPath:string; baseline:string; remote:string; parentReceipt?:string; parentCandidate?:{runId:string;id:string;receipt:string}};
