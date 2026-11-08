// Versioned, declarative file rules. Operators are implemented by Grounds;
// publishing a rule never runs user-provided code.
import { createDefinition, isId, isText, publishRevision, refOf, type JsonValue } from "../domain/index.js";
import type { WorkRepositories } from "../ports/index.js";
import { ensureFileMatchGrader } from "./builtin-grader.js";
import { fail, fromRejection, succeed } from "./outcome.js";
import { once, type RequestContext } from "./requests.js";

export type RuleOperation = "equal-file-bytes" | "file-exists";
export type Rule = { strategy: "rule"; operation: RuleOperation; scale: { form: "category"; categories: string[] } };
export type GraderSelection = { definitionId: string; revisionId: string };

export function fileRule(content: JsonValue): Rule | undefined {
  const rule = content as Partial<Rule> | null;
  if (rule?.strategy !== "rule" || !["equal-file-bytes", "file-exists"].includes(rule.operation ?? "") ||
      rule.scale?.form !== "category" || rule.scale.categories.length !== 2 || rule.scale.categories[0] === rule.scale.categories[1]) return undefined;
  return rule as Rule;
}

export async function resolveRule(r: WorkRepositories, ctx: RequestContext, selection?: GraderSelection) {
  if (selection) {
    const revision = await r.definitions.getRevision(selection.definitionId, selection.revisionId);
    if (!revision || revision.kind !== "grader") return fail("not-found", "selected grader revision does not exist");
    const ref = refOf(revision);
    const rule = fileRule(revision.content);
    return rule ? succeed({ ref, rule }) : fail("unsupported", "this grader does not implement a supported file rule");
  }
  const builtin = await ensureFileMatchGrader(r, ctx.hash, ctx.now());
  if (!builtin.ok) return builtin;
  const revision = await r.definitions.getRevision(builtin.value.definitionId, builtin.value.revisionId);
  return succeed({ ref: builtin.value, rule: fileRule(revision!.content)! });
}

type GraderInput = {requestId: string; name: string; pass: string; fail: string; graderId?: string; expectedSeq: number};
export type TestGrader = {strategy:"test"; environmentRevisionId:string; environment: {[K in keyof ReturnType<typeof refOf>]: ReturnType<typeof refOf>[K]}; commands:string[][]; scale: Rule["scale"]};

export function commandList(value: unknown): value is string[][] {
  return Array.isArray(value) && value.length > 0 && value.every(argv =>
    Array.isArray(argv) && argv.length > 0 && isText(argv[0], 4096) &&
    argv.every(arg => typeof arg === "string" && !arg.includes("\0")));
}

export function testGrader(content: JsonValue): TestGrader | undefined {
  const grader = content as Partial<TestGrader> | null;
  return grader?.strategy === "test" && grader.environment?.kind === "environment" &&
    grader.environment.revisionId === grader.environmentRevisionId && commandList(grader.commands) &&
    grader.scale?.form === "category" && grader.scale.categories.length === 2 ? grader as TestGrader : undefined;
}

export async function resolveSuiteGrader(r: WorkRepositories, ctx: RequestContext, selection?: GraderSelection) {
  if (selection) {
    const revision = await r.definitions.getRevision(selection.definitionId, selection.revisionId);
    const grader = revision?.kind === "grader" && testGrader(revision.content);
    if (grader) return succeed({ref:refOf(revision!), rule:grader});
  }
  return resolveRule(r, ctx, selection);
}

export class RuleDefinitions {
  constructor(private readonly ctx: RequestContext) {}

  publish(input: GraderInput & {operation: string}) {
    return once(this.ctx, {requestId: input.requestId, kind: "publish-rule", subject: {type:"grader", id:input.graderId ?? input.requestId}, input}, async r => {
      if (input.operation !== "equal-file-bytes" && input.operation !== "file-exists") return fail("invalid", "choose a supported file operation");
      return this.store(r, input, {strategy: "rule", operation: input.operation, scale: {form:"category", categories:[input.pass, input.fail]}});
    });
  }

  publishTest(input: GraderInput & {environmentId:string; environmentRevisionId:string; commands:string[][]}) {
    return once(this.ctx, {requestId:input.requestId, kind:"publish-test-grader", subject:{type:"grader", id:input.graderId ?? input.requestId}, input}, async r => {
      if (!commandList(input.commands)) return fail("invalid", "supply ordered commands as arrays of arguments");
      const environment = await r.definitions.getRevision(input.environmentId, input.environmentRevisionId);
      if (environment?.kind !== "environment") return fail("not-found", "select a published evaluator environment revision");
      return this.store(r, input, {strategy:"test", environment:refOf(environment), environmentRevisionId:environment.id,
        commands:input.commands, scale:{form:"category", categories:[input.pass, input.fail]}});
    });
  }

  private async store(r:WorkRepositories, input:GraderInput, content:Rule | TestGrader) {
    if (!isText(input.name,256) || !isText(input.pass,128) || !isText(input.fail,128) || input.pass === input.fail) {
      return fail("invalid", "provide a grader name and two distinct category labels");
    }
    if (input.graderId !== undefined && (!isId(input.graderId) || input.graderId.startsWith("builtin."))) return fail("invalid", "select a user-defined grader to revise");
    const at = this.ctx.now(), id = input.graderId ?? this.ctx.newId();
    let definition = await r.definitions.get(id, {lock:true});
    if (!input.graderId) {
      const created = createDefinition({kind:"grader", id, name:input.name, at});
      if (!created.ok) return fromRejection(created.error);
      definition = created.value.state;
      await r.definitions.create(definition);
    }
    if (definition?.kind !== "grader") return fail("not-found", "grader does not exist");
    const published = publishRevision(definition, {at, content, revisionId:this.ctx.newId(), expectedSeq:input.expectedSeq}, this.ctx.hash);
    if (!published.ok) return fromRejection(published.error);
    await r.definitions.save({...published.value.state, name:input.name}, definition.version);
    await r.definitions.addRevision(published.value.outcome);
    return succeed({graderId:id, revisionId:published.value.outcome.id, seq:published.value.outcome.seq, digest:published.value.outcome.digest});
  }
}
