import { commandList } from "../application/rule-definitions.js";
// The `task`, `work` and `grade` command groups. Each action maps to one use
// case; results are plain objects the outer envelope wraps. The operation id of
// a call is the request identity, so repeating a call with the same
// `--operation-id` is safe.
import { resolve } from "node:path";
import { DomainError, validation } from "../../errors.js";
import type { ParsedArgs } from "../../cli.js";
import type { CriterionVerdict, Grade, ProtocolStage } from "../domain/index.js";
import type { Outcome, WorkApplication } from "../application/index.js";

export const WORK_GROUPS = ["task", "work", "grade", "suite", "experiment"] as const;
export const WORK_WRITE_ACTIONS = new Set([
  "experiment:define", "experiment:launch", "experiment:resume", "experiment:cancel", "experiment:regrade",
  "grade:define-agent","grade:measure", "grade:resume-test","grade:resume-evaluator", "grade:define-test", "grade:define-rule", "suite:publish", "suite:measure",
  "work:resume-managed", "work:define-agent", "work:import-trace", "work:prepare-sandbox", "work:pause-sandbox", "work:release-sandbox", "work:define-environment", "task:create", "task:revise",
  "work:save-artifact", "work:submit-artifacts", "work:start", "work:start-run", "work:continue", "work:branch", "work:select", "work:close", "work:register", "work:transcript", "work:deliver", "work:repair", "work:stop", "work:cancel",
  "grade:request", "grade:register", "grade:stage", "grade:command", "grade:submit", "grade:stop", "grade:cancel",
]);

const CODES: Record<string, ConstructorParameters<typeof DomainError>[0]> = {
  invalid: "VALIDATION_ERROR", conflict: "STATE_CONFLICT", forbidden: "AUTH_FAILED", unsupported: "VALIDATION_ERROR", "not-found": "NOT_FOUND",
  stale: "VERSION_CONFLICT", "request-conflict": "IDEMPOTENCY_CONFLICT", unavailable: "STORAGE_TRANSIENT",
};
const unwrap = <T>(outcome: Outcome<T>): T => {
  if (outcome.ok) return outcome.value;
  throw new DomainError(CODES[outcome.error.code] ?? "VALIDATION_ERROR", outcome.error.message, outcome.error.code === "unavailable");
};

const raw = (args: ParsedArgs, name: string): string | boolean | string[] | undefined => args.values[name];
const text = (args: ParsedArgs, name: string): string | undefined => { const v = raw(args, name); return typeof v === "string" ? v : Array.isArray(v) ? v[v.length - 1] : undefined; };
const need = (args: ParsedArgs, name: string): string => { const v = text(args, name); if (v === undefined || v === "") throw validation(name, "is required"); return v; };
const many = (args: ParsedArgs, name: string): string[] => { const v = raw(args, name); return Array.isArray(v) ? v : typeof v === "string" ? [v] : []; };
const flag = (args: ParsedArgs, name: string): boolean => raw(args, name) === true || raw(args, name) === "true";
const integer = (args: ParsedArgs, name: string): number => { const n = Number(need(args, name)); if (!Number.isSafeInteger(n) || n < 0) throw validation(name, "must be a non-negative integer"); return n; };
const requestId = (args: ParsedArgs): string => need(args, "operation-id");
const taskOutputs = (args:ParsedArgs) => {
  const options = ["required-output","optional-output"] as const;
  if (options.every(key=>raw(args,key) === undefined)) return {};
  return {outputs:options.flatMap(key=>{
    if (raw(args,key) !== undefined) need(args,key);
    return many(args,key).map(slot=>({key:slot,required:key === "required-output"}));
  })};
};
const taskMaterials = (args:ParsedArgs,deps:WorkEntryDependencies) => {
  if (raw(args,"materials") === undefined) return {};
  let entries;
  try {entries = JSON.parse(deps.readFile(need(args,"materials")));} catch {throw validation("materials","expected a JSON list");}
  if (!Array.isArray(entries)) throw validation("materials","expected a list of pinned Git repositories");
  return {materialRepositories:entries.map(item=>{
    if (!item || typeof item.name !== "string" || typeof item.repository !== "string" || !item.repository.trim() || typeof item.commit !== "string") throw validation("materials","expected name, repository and commit");
    return {name:item.name,repository:resolve(deps.cwd,item.repository),commit:item.commit};
  })};
};
const taskKind = (args: ParsedArgs): {kind?: "coding" | "working"} => {
  if (raw(args,"kind") === undefined) return {};
  const kind = need(args,"kind");
  if (kind !== "coding" && kind !== "working") throw validation("kind","must be coding or working");
  return {kind};
};
const mode = (args: ParsedArgs): "external" | "none" | "managed" => { const m = need(args, "mode"); if (m !== "external" && m !== "none" && m !== "managed") throw validation("mode", "must be external, none or managed"); return m; };
const archiveProtection = (args: ParsedArgs) => {
  const level = text(args, "protection"), evidence = text(args, "protection-evidence");
  if (level === undefined && evidence === undefined) return undefined;
  if (level !== "protected" && level !== "unprotected") throw validation("protection", "must be protected or unprotected with a policy evidence reference");
  if (!evidence?.trim() || evidence.length > 256) throw validation("protection-evidence", "must identify the observed policy in at most 256 characters");
  return { level, evidence } as const;
};
const result = (group: string, action: string, data: object) => ({ result_type: `grounds.result.${group}.${action}/v1`, command: `${group}.${action}`, ...data });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `--criterion "text"` is a new criterion; `--criterion "<id>: text"` keeps the identity of one from the previous revision. */
const criteria = (args: ParsedArgs) => many(args, "criterion").map(entry => {
  const head = /^(\S+): (.+)$/s.exec(entry);
  return head && UUID.test(head[1]!) ? { id: head[1]!, statement: head[2]! } : { statement: entry };
});
const repository = (args: ParsedArgs) => text(args, "repo-remote") || text(args, "baseline") ? { remote: need(args, "repo-remote"), baseline: need(args, "baseline") } : undefined;

const verdicts = ["satisfied", "unsatisfied", "indeterminate"] as const;
const relations = ["corroborated", "contradicted", "not_determined"] as const;
/** Snake-case verdicts as written in a grade file, turned into the domain's shape. */
export function parseGrade(json: unknown): Grade {
  const body = json as { criteria?: unknown };
  if (!body || typeof body !== "object" || !Array.isArray(body.criteria)) throw validation("grade", 'must be {"criteria": [...]}');
  const items: CriterionVerdict[] = body.criteria.map((entry: Record<string, unknown>) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw validation("grade", "each criterion must be an object");
    const { criterion_id, independent, reconciliation, final, rationale, evidence } = entry as { criterion_id?: string; independent?: string; reconciliation?: string; final?: string; rationale?: string; evidence?: unknown };
    if (typeof criterion_id !== "string" || typeof rationale !== "string") throw validation("grade", "each criterion needs a textual criterion_id and rationale");
    if (!verdicts.includes(independent as never) || !verdicts.includes(final as never)) throw validation("grade", `each criterion needs independent and final verdicts from: ${verdicts.join(", ")}`);
    if (!relations.includes(reconciliation as never)) throw validation("grade", `reconciliation must be one of: ${relations.join(", ")}`);
    if (evidence !== undefined && !(Array.isArray(evidence) && evidence.every(e => typeof e === "string"))) throw validation("grade", "evidence is a list of text");
    return { criterionId: criterion_id, independent: independent as CriterionVerdict["independent"], reconciliation: reconciliation as CriterionVerdict["reconciliation"], final: final as CriterionVerdict["final"], rationale, evidence: (evidence as string[] | undefined) ?? [] };
  });
  return { form: "criteria", items };
}

export interface WorkEntryDependencies { readonly app: WorkApplication; readonly artifactFile:(path:string)=>Promise<{source:import("../application/artifacts.js").ArtifactSource;dispose():Promise<void>}>; readonly cwd: string; readonly readFile: (path: string) => string }

export async function executeWorkCommand(args: ParsedArgs, deps: WorkEntryDependencies): Promise<unknown> {
  const [group, action] = [args.positionals[0] ?? "", args.positionals[1] ?? ""];
  const { app } = deps;
  const r = group === "experiment" ? await experiment(args,action,app,deps) : group === "suite" ? await suite(args, action, app, deps) : group === "task" ? await task(args, action, app, deps) : group === "work" ? await work(args, action, app, deps) : await grade(args, action, app, deps);
  return result(group, action, r);
}

async function experiment(args:ParsedArgs,action:string,app:WorkApplication,deps:WorkEntryDependencies):Promise<object> {
  const batch = () => need(args,"batch");
  switch (action) {
    case "define": {
      const overrides:Record<string,{repositoryPath:string}> = Object.create(null);
      if (text(args,"overrides")) {
        let parsed;
        try { parsed = JSON.parse(deps.readFile(need(args,"overrides"))); } catch { throw validation("overrides","expected a JSON case map"); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw validation("overrides","expected a JSON case map");
        for (const [key,value] of Object.entries(parsed)) {
          if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([k,v])=>
            k !== "repositoryPath" || typeof v !== "string" || !v.trim())) throw validation("overrides","invalid case override");
          const v = value as {repositoryPath?:string};
          if (!v.repositoryPath) throw validation("overrides","each case needs a repositoryPath");
          overrides[key] = {repositoryPath:resolve(deps.cwd,v.repositoryPath)};
        }
      }
      return unwrap(await app.experiments.define({requestId:requestId(args), name:need(args,"name"), suiteId:need(args,"suite"),seq:integer(args,"revision"),
        agentId:need(args,"agent"),agentRevisionId:need(args,"agent-revision"),repositoryPath:resolve(deps.cwd,text(args,"repo") ?? "."),overrides}));
    }
    case "launch": return unwrap(await app.experiments.launch({requestId:requestId(args),experimentId:need(args,"experiment"),
      ...(raw(args,"repeat") === undefined ? {} : {repeatCount:integer(args,"repeat")}),...(raw(args,"concurrency") === undefined ? {} : {taskConcurrency:integer(args,"concurrency")})}));
    case "show": return unwrap(await app.experiments.show(need(args,"experiment")));
    case "results": return unwrap<object>(await app.experimentResults.inspect(batch()));
    case "member": return unwrap<object>(await app.experimentResults.inspect(batch(),need(args,"member")));
    case "resume": return unwrap(await app.members.resume(batch(),requestId(args)));
    case "cancel": return unwrap(await app.members.cancel(batch(),requestId(args)));
    case "regrade": return unwrap<object>(await app.members.measure(batch(),need(args,"member"),need(args,"binding"),requestId(args)));
    default: throw validation("action","unknown experiment action: " + action);
  }
}

async function suite(args: ParsedArgs, action: string, app: WorkApplication, deps: WorkEntryDependencies): Promise<object> {
  const repo = resolve(deps.cwd, text(args,"repo") ?? ".");
  switch (action) {
    case "publish": {
      const path = need(args, "cases-file");
      let cases: unknown;
      try { cases = JSON.parse(deps.readFile(path)); } catch { throw validation("cases-file", "must be a readable JSON array"); }
      const suiteId = text(args, "suite");
      return unwrap(await app.suites.publish({ requestId: requestId(args), name: need(args, "name"), cases,
        ...(suiteId ? { suiteId } : {}), expectedSeq: text(args, "expected-seq") === undefined && !suiteId ? 0 : integer(args, "expected-seq") }, repo));
    }
    case "show": return unwrap(await app.suites.show(need(args, "suite"), integer(args, "revision")));
    case "list": return unwrap(await app.suites.list());
    case "measure": return unwrap(await app.suites.measure({ requestId: requestId(args), suiteId: need(args, "suite"), seq: integer(args, "revision"),
      caseKey: need(args, "case"), ...(text(args, "binding") ? {bindingKey: need(args,"binding")} : {}), runId: need(args, "run"), deliveryId: need(args, "delivery") }, repo));
    default: throw validation("action", `unknown suite action: ${action}`);
  }
}

async function task(args: ParsedArgs, action: string, app: WorkApplication, deps:WorkEntryDependencies): Promise<object> {
  switch (action) {
    case "create": return unwrap(await app.tasks.createTask({ ...taskKind(args), ...taskOutputs(args), ...taskMaterials(args,deps), requestId: requestId(args), summary: need(args, "title"), ...(raw(args,"environment") !== undefined ? { environmentDefinitionId: need(args,"environment") } : {}), criteria: criteria(args), ...(text(args, "name") ? { name: text(args, "name")! } : {}), ...(text(args, "context") ? { context: text(args, "context")! } : {}), ...(repository(args) ? { repository: repository(args)! } : {}) }));
    case "revise": return unwrap(await app.tasks.reviseTask({ ...taskKind(args), ...taskOutputs(args), ...taskMaterials(args,deps), requestId: requestId(args), taskId: need(args, "task"), expectedSeq: integer(args, "expected-seq"), summary: need(args, "title"), ...(raw(args,"environment") !== undefined ? { environmentDefinitionId: need(args,"environment") } : {}), criteria: criteria(args), ...(text(args, "context") ? { context: text(args, "context")! } : {}), ...(repository(args) ? { repository: repository(args)! } : {}) }));
    case "show": return unwrap(await app.tasks.getTask(need(args, "task"), text(args, "revision") !== undefined ? integer(args, "revision") : undefined));
    case "list": return { tasks: unwrap(await app.tasks.listTasks()) };
    default: throw validation("action", `unknown task action: ${action}`);
  }
}

async function work(args: ParsedArgs, action: string, app: WorkApplication, deps: WorkEntryDependencies): Promise<object> {
  const sandboxChoice = () => {
    if (raw(args, "sandbox") === undefined) return {};
    const sandbox = need(args, "sandbox");
    if (sandbox !== "fresh" && sandbox !== "inherit") throw validation("sandbox", "expected fresh or inherit");
    return {sandbox} as {sandbox: "fresh" | "inherit"};
  };
  const selection = () => raw(args,"agent")!==undefined || raw(args,"agent-revision")!==undefined ? {agent:{
    definitionId:need(args,"agent"),repositoryPath:resolve(deps.cwd,text(args,"repo")??"."),
    ...(raw(args,"agent-revision")!==undefined ? {revisionId:need(args,"agent-revision")} : {}),
  }} : {};
  switch (action) {
    case "resume-managed": return unwrap(await app.workers.resume(need(args, "run"), requestId(args)));
    case "managed-status": {
      const context=unwrap(await app.workers.context(need(args,"run")));
      return {runId:context.run.id,executionId:context.exec.id,stage:context.exec.stage,stop:context.exec.stop,
        status:context.run.status,agent:context.exec.agentRevision,receipts:context.exec.receipts,...(context.job.observation?{host:context.job.observation}:{}),...(context.job.trace?{trace:context.job.trace}:{})};
    }
    case "define-agent": {
      const provider=need(args,"provider");
      if (provider!=="codex" && provider!=="claude-code") throw validation("provider","expected codex or claude-code");
      const definitionId=text(args,"agent");
      return unwrap(await app.agents.publish({requestId:requestId(args),name:need(args,"name"),provider,...(raw(args,"model")!==undefined?{model:need(args,"model")} : {}),
        ...(definitionId?{definitionId}:{}),expectedSeq:definitionId || raw(args,"expected-seq")!==undefined ? integer(args,"expected-seq") : 0}));
    }
    case "import-trace": {
      const provider = need(args,"provider");
      if (provider !== "codex" && provider !== "claude-code") throw validation("provider","expected codex or claude-code");
      return unwrap(await app.traces.import({requestId:requestId(args),runId:need(args,"run"),sessionId:need(args,"session"),digest:need(args,"digest"),provider},resolve(deps.cwd,need(args,"file"))));
    }
    case "trace": {
      const {data,...metadata} = unwrap(await app.traces.read(need(args,"run"),need(args,"digest"),need(args,"stream"),integer(args,"chunk")));
      return {...metadata,base64:Buffer.from(data).toString("base64")};
    }
    case "prepare-sandbox": return unwrap(await app.sandboxes.prepare(requestId(args), need(args,"run"), resolve(deps.cwd, text(args,"repo") ?? ".")));
    case "reconcile-sandbox": return unwrap(await app.sandboxes.reconcile(need(args,"run")));
    case "pause-sandbox": return unwrap(await app.lifecycle.lifecycle(requestId(args), need(args,"run"), "pause"));
    case "release-sandbox": return unwrap(await app.lifecycle.lifecycle(requestId(args), need(args,"run"), "release"));
    case "define-environment": {
      const id = text(args, "environment");
      const read = (name: string) => {
        const path = need(args, name);
        try { return deps.readFile(path); } catch { throw validation(name, "must be a readable file"); }
      };
      const config = read("devcontainer");
      return unwrap(await app.environments.publish({ requestId: requestId(args), name: need(args,"name"), config,
        imageDigest: need(args,"image-digest"), ...(raw(args,"lockfile") !== undefined ? { lockfile: read("lockfile") } : {}),
        ...(id ? { definitionId: id } : {}), expectedSeq: id || raw(args,"expected-seq") !== undefined ? integer(args,"expected-seq") : 0 }));
    }
    case "environment": return unwrap(await app.environments.show(need(args,"environment"), integer(args,"revision")));
    case "start-run": {
      const retention=raw(args,"retention")===undefined ? "keep" : need(args,"retention");
      if (retention!=="release" && retention!=="keep") throw validation("retention","expected keep or release");
      return unwrap(await app.exec.startRun({requestId:requestId(args),taskDefinitionId:need(args,"task"),workerMode:mode(args),retention,...selection(),...sandboxChoice(),
        ...(raw(args,"refines")!==undefined ? {refines:need(args,"refines")} : {}),
        ...(raw(args,"environment-revision")!==undefined ? {environmentRevisionId:need(args,"environment-revision")} : {}),
        ...(raw(args,"revision-id")!==undefined ? {taskRevisionId:need(args,"revision-id")} : {})}));
    }
    case "start": return unwrap(await app.exec.startWork({ requestId: requestId(args), taskDefinitionId: need(args, "task"), workerMode: mode(args), ...selection(), ...(raw(args,"environment-revision") !== undefined ? { environmentRevisionId: need(args,"environment-revision") } : {}), ...(text(args, "revision-id") ? { taskRevisionId: text(args, "revision-id")! } : {}) }));
    case "continue": return unwrap(await app.exec.continueWork({ ...sandboxChoice(), requestId: requestId(args), workId: need(args, "work"), expectedHead: need(args, "expected-head"), workerMode: mode(args), ...selection(), ...(raw(args,"environment-revision") !== undefined ? { environmentRevisionId: need(args,"environment-revision") } : {}), ...(text(args, "revision-id") ? { taskRevisionId: text(args, "revision-id")! } : {}) }));
    case "branch": return unwrap(await app.exec.addBranch({ ...sandboxChoice(), requestId: requestId(args), workId: need(args, "work"), refines: need(args, "refines"), workerMode: mode(args), ...selection(), ...(raw(args,"environment-revision") !== undefined ? { environmentRevisionId: need(args,"environment-revision") } : {}), ...(text(args, "revision-id") ? { taskRevisionId: text(args, "revision-id")! } : {}) }));
    case "select": return unwrap(await app.exec.selectHead({ requestId: requestId(args), workId: need(args, "work"), runId: need(args, "run"), ...(text(args, "expected-head") ? { expectedHead: text(args, "expected-head")! } : {}) }));
    case "close": return unwrap(await app.exec.closeWork({ requestId: requestId(args), workId: need(args, "work") }));
    case "show": {
      const view = unwrap(await app.exec.getWork(need(args, "work")));
      const head = view.runs.find(run => run.id === view.work.head);
      return { ...view, archiveIntegrity: head ? await app.repairs.inspectRun(head, text(args, "repo") ?? deps.cwd) : [] };
    }
    case "run": {
      const view = unwrap(await app.exec.getRun(need(args, "run")));
      return { ...view, archiveIntegrity: await app.repairs.inspectRun(view.run, text(args, "repo") ?? deps.cwd) };
    }
    case "register": return unwrap(await app.exec.registerExternalWorker({ requestId: requestId(args), runId: need(args, "run"), agent: { id: need(args, "agent"), ...(text(args, "agent-name") ? { name: text(args, "agent-name")! } : {}), ...(text(args, "model") ? { model: text(args, "model")! } : {}) } }));
    case "transcript": return unwrap(await app.exec.importTranscript({ requestId: requestId(args), runId: need(args, "run"), sessionId: need(args, "session"), ref: need(args, "ref"), digest: need(args, "digest"), coverage: need(args, "coverage") as "full" | "partial" | "unknown" }));
    case "workspace": return unwrap<object>(await app.delivery.workspace({ runId: need(args, "run"), repositoryPath: text(args, "repo") ?? deps.cwd }));
    case "reconcile": {
      const runId=need(args,"run"), submission=unwrap(await app.exec.reconcileSubmission(runId));
      return {...unwrap(await app.repairs.reconcile(runId)),...(submission ? {submission} : {})};
    }
    case "repair": return { repair: unwrap(await app.repairs.repair({ requestId: requestId(args), runId: need(args, "run"), deliveryId: need(args, "delivery"), repositoryPath: text(args, "repo") ?? deps.cwd })) };
    case "save-artifact": {
      const names = many(args,"file");
      const files = [], cleanups:(()=>Promise<void>)[] = [];
      try {
        for (const name of names) {
          const sep = name.indexOf("=");
          if (sep < 1 || sep === name.length-1) throw validation("file","expected archived/path=local-file");
          const captured = await deps.artifactFile(name.slice(sep+1));
          cleanups.push(captured.dispose);
          files.push({path:name.slice(0,sep),source:captured.source});
        }
        return {artifact:unwrap(await app.artifacts.save({requestId:requestId(args),runId:need(args,"run"),slot:need(args,"slot"),
          ...(text(args,"session") ? {sessionId:text(args,"session")} : {})},files))};
      } finally {await Promise.all(cleanups.map(dispose=>dispose()));}
    }
    case "artifact": return {artifact:unwrap(await app.artifacts.get(need(args,"run"),need(args,"artifact")))};
    case "artifact-file": {
      const {data,...metadata} = unwrap(await app.artifacts.chunk(need(args,"run"),need(args,"artifact"),need(args,"path"),integer(args,"chunk")));
      return {...metadata,base64:Buffer.from(data).toString("base64")};
    }
    case "submit-artifacts": {
      const runId = need(args,"run");
      const items = await Promise.all(many(args,"artifact").map(async id=>{
        const saved = unwrap(await app.artifacts.get(runId,id));
        return {type:"artifact" as const,id,receipt:saved.receipt};
      }));
      return {submitted:unwrap(await app.exec.submit({requestId:requestId(args),runId,items,...(text(args,"session") ? {sessionId:text(args,"session")} : {})}))};
    }
    case "deliver": return unwrap(await app.delivery.deliver({ artifactIds:many(args,"artifact"), protection: archiveProtection(args), requestId: requestId(args), runId: need(args, "run"), repositoryPath: text(args, "repo") ?? deps.cwd, commit: text(args, "commit") ?? "HEAD",
      ...(text(args, "session") ? { sessionId: text(args, "session")! } : {}), ...(text(args, "remote") ? { remote: text(args, "remote")! } : {}), ...(flag(args, "declare-stop") ? { declaresStop: true } : {}) }));
    case "stop": return unwrap(await app.exec.declareStop({ requestId: requestId(args), runId: need(args, "run"), reason: need(args, "reason") as "human" | "abandoned", ...(text(args, "session") ? { sessionId: text(args, "session")! } : {}) }));
    case "cancel": return unwrap(await app.exec.cancel({ requestId: requestId(args), runId: need(args, "run"), ...(text(args, "reason") ? { reason: text(args, "reason")! } : {}) }));
    default: throw validation("action", `unknown work action: ${action}`);
  }
}

async function grade(args: ParsedArgs, action: string, app: WorkApplication, deps: WorkEntryDependencies): Promise<object> {
  const grading = need.bind(null, args, "grading");
  switch (action) {
    case "measure": {
      const reference = ["reference-path", "reference-run", "reference-delivery"].some(key => raw(args, key) !== undefined) ? {
        path: need(args, "reference-path"), runId: need(args, "reference-run"), deliveryId: need(args, "reference-delivery"),
      } : undefined;
      return unwrap(await app.suites.measureDirect({ requestId: requestId(args), runId: need(args, "run"), deliveryId: need(args, "delivery"),
        grader: { definitionId: need(args, "grader"), revisionId: need(args, "grader-revision") }, answerPath: need(args, "answer-path"),
        ...(reference ? { reference } : {}) }, text(args, "repo") ?? deps.cwd));
    }
    case "resume-evaluator":
    case "resume-test": return unwrap(await app.tests.resume(grading(),requestId(args)));
    case "test-output": {
      const {bytes,...ref} = unwrap(await app.tests.readOutput(grading(),integer(args,"step"),need(args,"stream"),integer(args,"chunk")));
      return {...ref,base64:Buffer.from(bytes).toString("base64")};
    }
    case "evaluator-evidence": {
      const {bytes,...metadata}=unwrap(await app.evaluators.evidence(grading(),need(args,"stream"),integer(args,"chunk")));
      return {...metadata,base64:Buffer.from(bytes).toString("base64")};
    }
    case "evaluator-status":
    case "test-status": {
      const ctx = unwrap(await app.tests.context(grading()));
      return {gradingId:ctx.grading.id, status:ctx.grading.status, ...(ctx.sandbox ? {sandboxPhase:ctx.sandbox.phase} : {}),
        ...(ctx.observation ? {host:ctx.observation} : {})};
    }
    case "define-agent": {
      let scale:import("../domain/index.js").JsonValue;
      try {scale=JSON.parse(deps.readFile(need(args,"scale")));} catch {throw validation("scale","expected a JSON scale file");}
      const graderId=text(args,"grader");
      return unwrap(await app.rules.publishAgent({requestId:requestId(args),name:need(args,"name"),rubric:need(args,"rubric"),scale,
        agentId:need(args,"agent"),agentRevisionId:need(args,"agent-revision"),environmentId:need(args,"environment"),environmentRevisionId:need(args,"environment-revision"),
        ...(graderId ? {graderId} : {}),expectedSeq:graderId || raw(args,"expected-seq")!==undefined ? integer(args,"expected-seq") : 0}));
    }
    case "define-test": {
      let commands: unknown;
      try { commands = JSON.parse(deps.readFile(need(args, "commands"))); }
      catch { throw validation("commands", "supply a readable JSON command list"); }
      if (!commandList(commands)) throw validation("commands", "expected a nonempty list of argument arrays");
      const graderId = text(args,"grader");
      return unwrap(await app.rules.publishTest({requestId:requestId(args), name:need(args,"name"), commands,
        environmentId:need(args,"environment"), environmentRevisionId:need(args,"environment-revision"),
        pass:need(args,"pass"), fail:need(args,"fail"), ...(graderId ? {graderId} : {}),
        expectedSeq:graderId || text(args,"expected-seq") !== undefined ? integer(args,"expected-seq") : 0}));
    }
    case "define-rule": {
      const graderId = text(args, "grader");
      return unwrap(await app.rules.publish({ requestId: requestId(args), name: need(args, "name"), operation: need(args, "rule"),
        pass: need(args, "pass"), fail: need(args, "fail"), ...(graderId ? { graderId } : {}),
        expectedSeq: graderId || text(args,"expected-seq") !== undefined ? integer(args, "expected-seq") : 0 }));
    }
    case "request": return unwrap(await app.grading.requestGate({ requestId: requestId(args), taskRunId: need(args, "run"), materials: many(args, "material").map(entry => { const [id, digest] = entry.split("="); if (!id || !digest) throw validation("material", "is id=digest"); return { id, digest }; }) }));
    case "register": return unwrap(await app.grading.registerExternalEvaluator({ requestId: requestId(args), gradingId: grading(), agent: { id: need(args, "agent") } }));
    case "stage": return unwrap(await app.grading.recordStage({ requestId: requestId(args), gradingId: grading(), sessionId: need(args, "session"), stage: need(args, "stage") as ProtocolStage, ...(text(args, "blind-digest") ? { blindDigest: text(args, "blind-digest")! } : {}) }));
    case "command": return unwrap(await app.grading.recordCommand({ requestId: requestId(args), gradingId: grading(), sessionId: need(args, "session"), observation: {
      stage: need(args, "stage") as ProtocolStage, entry: need(args, "entry"), argvDigest: need(args, "argv-digest"), state: need(args, "state") as "succeeded" | "failed" | "unknown", ...(text(args, "exit-code") !== undefined ? { exitCode: integer(args, "exit-code") } : {}), at: new Date().toISOString() } }));
    case "submit": {
      let json: unknown;
      try { json = JSON.parse(deps.readFile(need(args, "grade-file"))); } catch (error) { if (error instanceof DomainError) throw error; throw validation("grade-file", "must be a readable JSON file"); }
      return unwrap(await app.grading.submitGrade({ requestId: requestId(args), gradingId: grading(), sessionId: need(args, "session"), grade: parseGrade(json) }));
    }
    case "stop": return unwrap(await app.grading.declareEvaluatorStop({ requestId: requestId(args), gradingId: grading(), ...(text(args, "session") ? { sessionId: text(args, "session")! } : {}) }));
    case "cancel": return unwrap(await app.grading.cancel({ requestId: requestId(args), gradingId: grading() }));
    case "show": {
      const record = unwrap(await app.grading.getGrading(grading()));
      const runId = record.origin.type === "gate" ? record.origin.taskRunId : record.origin.type === "standalone" ? record.origin.historical?.taskRunId ?? record.origin.direct?.taskRunId : undefined;
      if (!runId) return record;
      const { run } = unwrap(await app.exec.getRun(runId));
      return { ...record, archiveIntegrity: await app.repairs.inspectRun(run, text(args, "repo") ?? deps.cwd) };
    }
    case "list": {
      const runId = need(args, "run");
      const gates = unwrap(await app.grading.listGates(runId));
      const archiveIntegrity = gates.length ? await app.repairs.inspectRun(unwrap(await app.exec.getRun(runId)).run, text(args, "repo") ?? deps.cwd) : [];
      return { gates, archiveIntegrity };
    }
    default: throw validation("action", `unknown grade action: ${action}`);
  }
}

export const workHelp = (): string => [
  "grounds experiment define --name NAME --suite ID --revision N --agent ID --agent-revision REV [--repo PATH --overrides FILE]",
  "grounds experiment launch --experiment ID [--repeat N --concurrency N] | experiment show --experiment ID",
  "grounds experiment results|resume|cancel --batch ID | experiment member --batch ID --member KEY | experiment regrade --batch ID --member KEY --binding KEY",
  "grounds grade measure --run RUN --delivery ID --grader ID --grader-revision ID --answer-path PATH [--reference-run RUN --reference-delivery ID --reference-path PATH]",
  "grounds grade test-status|resume-test --grading ID | grade test-output --grading ID --step N --stream stdout|stderr --chunk N",
  "grounds grade define-agent --name NAME --agent ID --agent-revision REV --environment ID --environment-revision REV --rubric TEXT --scale FILE",
  "grounds grade evaluator-status|resume-evaluator --grading ID | grade evaluator-evidence --grading ID --stream raw|events|output|stderr --chunk N",
  "grounds grade define-test --name NAME --commands FILE --environment ID --environment-revision REV --pass LABEL --fail LABEL",
  "grounds grade define-rule --name NAME --rule equal-file-bytes|file-exists --pass LABEL --fail LABEL [--grader ID --expected-seq N]",
  "grounds suite publish --name NAME --cases-file FILE [--suite ID --expected-seq N] [--repo PATH]",
  "grounds suite show --suite ID --revision N | suite list | suite measure --suite ID --revision N --case KEY [--binding KEY] --run RUN --delivery ID [--repo PATH]",
  "grounds task create [--kind coding|working] [--materials FILE] [--required-output KEY... --optional-output KEY...] --title TEXT --criterion TEXT... [--context TEXT] [--environment ID] [--repo-remote URL --baseline REF]",
  "grounds task revise --task ID --expected-seq N --title TEXT --criterion [ID: ]TEXT... | task show --task ID [--revision N] | task list",
  "grounds work define-agent --name NAME --provider codex|claude-code [--model MODEL] [--agent ID --expected-seq N]",
  "grounds work start --task ID --mode managed --agent ID [--agent-revision REV --repo PATH] | work managed-status|resume-managed --run RUN",
  "grounds work import-trace --run RUN --session SESSION --provider codex|claude-code --file FILE --digest SHA256 | work trace --run RUN --digest SHA256 --stream raw|events --chunk N",
  "grounds work prepare-sandbox --run RUN [--repo PATH] | work reconcile-sandbox --run RUN | work pause-sandbox|release-sandbox --run RUN",
  "grounds work define-environment --name NAME --devcontainer FILE --image-digest SHA256 [--lockfile FILE] [--environment ID --expected-seq N] | work environment --environment ID --revision N",
  "grounds work start-run --task ID --mode external|none|managed [--refines RUN] [--retention release|keep] [--sandbox fresh|inherit]",
  "grounds work start --task ID --mode external|none [--environment-revision ID] | work continue --work ID --expected-head RUN --mode M [--sandbox inherit|fresh] | work branch --work ID --refines RUN --mode M [--sandbox fresh|inherit]",
  "grounds work select --work ID --run RUN [--expected-head RUN] | work close --work ID | work show --work ID [--repo PATH] | work run --run RUN [--repo PATH]",
  "grounds work save-artifact --run RUN [--session S] --slot KEY --file ARCHIVED_PATH=LOCAL_FILE... | work submit-artifacts --run RUN [--session S] --artifact ID...",
  "grounds work artifact --run RUN --artifact ID | work artifact-file --run RUN --artifact ID --path PATH --chunk N",
  "grounds work register --run RUN --agent NAME   (prints the session to present when delivering)",
  "grounds work workspace --run RUN [--repo PATH]   (a private worktree: the baseline, or what the refined run delivered)",
  "grounds work deliver --run RUN [--session S] [--repo PATH] [--commit REF] [--remote URL] [--declare-stop] [--protection protected|unprotected --protection-evidence REF]",
  "grounds work reconcile --run RUN  (recheck the pending submission and outstanding repair tags)",
  "grounds work repair --run RUN --delivery ID [--repo PATH]  (record another verified archive tag for the same frozen commit)",
  "grounds work stop --run RUN --reason human|abandoned [--session S] | work cancel --run RUN [--reason TEXT] | work transcript --run RUN --session S --ref REF --digest D --coverage full|partial|unknown",
  "grounds grade request --run RUN [--material ID=DIGEST...] | grade register --grading ID --agent NAME | grade stage --grading ID --session S --stage blind|freeze|reconcile|handoff|submit [--blind-digest D]",
  "grounds grade command --grading ID --session S --stage STAGE --entry NAME --argv-digest D --state succeeded|failed|unknown [--exit-code N]",
  "grounds grade submit --grading ID --session S --grade-file FILE   ({\"criteria\":[{criterion_id,independent,reconciliation,final,rationale,evidence}]})",
  `  independent and final: ${verdicts.join(" | ")}; reconciliation: ${relations.join(" | ")}; evidence: list of strings`,
  "grounds grade stop|cancel --grading ID | grade show --grading ID | grade list --run RUN",
  "Every write prints an operation_id; repeat the call with --operation-id to retry it safely.",
].join("\n");
