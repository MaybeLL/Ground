import type {BuildSource,EnvironmentBuilder} from "../ports/environment-build.js";
import { createDefinition, isDigest, isId, isText, publishRevision, refOf, resolveEnvironment, parseTaskContent, type Revision, type ResolvedEnvironment } from "../domain/index.js";
import type { WorkRepositories } from "../ports/index.js";
import { fail, fromRejection, succeed, type Outcome } from "./outcome.js";
import { once, type RequestContext } from "./requests.js";

export type EnvironmentContent = {
  format: "grounds.devcontainer/v1";
  config: string;
  lockfile: string | null;
  lockfileDigest: string | null;
  imageDigest: string;
  build?: {commit:string;path:string;source:string};
};

type Publication = {requestId:string;name:string;config:string;imageDigest:string;lockfile?:string;definitionId?:string;expectedSeq:number};
type Published = {environmentId:string;revisionId:string;seq:number;digest:string};


/** Preserve the exact devcontainer source (including JSONC comments) and the
 * lockfile alongside the immutable identity of the image chosen for this environment. */
export class EnvironmentDefinitions {
  constructor(private readonly ctx: RequestContext, private readonly validate: (config: string, digest: string) => unknown, private readonly builder?:EnvironmentBuilder) {}

  publish(input:Publication) {
    return this.publishRevision(input);
  }

  async build(input:BuildSource & {requestId:string;name:string;definitionId?:string;expectedSeq:number}):Promise<Outcome<Published>> {
    if (!this.builder) return fail("unsupported","the environment image builder is unavailable");
    if (!isId(input.requestId) || !isText(input.name,256) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit) ||
        !isText(input.repository,4096) || !isText(input.path,1024) || !Number.isSafeInteger(input.expectedSeq) || input.expectedSeq<0) {
      return fail("invalid","provide a named environment, repository, full Git commit and configuration path");
    }
    const reservation=await once(this.ctx,{kind:"reserve-environment-build",requestId:input.requestId,input,subject:{type:"environment",id:input.definitionId ?? input.requestId}},async r=>{
      if (input.definitionId) {
        const prior=await r.definitions.get(input.definitionId,{lock:true});
        if (prior?.kind!=="environment") return fail("not-found","environment definition does not exist");
        if (prior.head.seq!==input.expectedSeq) return fail("stale","environment revision has changed");
      } else if (input.expectedSeq!==0) return fail("invalid","a new environment starts at sequence zero");
      return succeed({buildId:this.ctx.newId()});
    });
    if (!reservation.ok) return reservation;
    const id=reservation.value.buildId;
    const prior=await this.ctx.units.run("read",r=>r.intents.findByRequest(id));
    if (prior) {
      if (prior.kind!=="publish-built-environment" || prior.state!=="completed" || prior.subject.id!==(input.definitionId ?? id)) return fail("request-conflict","environment publication identity is already occupied");
      return succeed(prior.result as Published);
    }
    const built=await this.builder(id,input);
    if (built.status!=="built") return fail(built.status,built.reason);
    const {source,...image}=built.image;
    return this.publishRevision({requestId:id,name:input.name,expectedSeq:input.expectedSeq,...(input.definitionId ? {definitionId:input.definitionId} : {}),...image},
      {commit:input.commit,path:input.path,source});
  }

  private publishRevision(input:Publication,build?:EnvironmentContent["build"]) {
    if (!isId(input.requestId) || !isText(input.name, 256) || !isText(input.config, 1024 * 1024) || !isDigest(input.imageDigest) ||
        (input.lockfile !== undefined && !isText(input.lockfile, 1024 * 1024))) return Promise.resolve(fail("invalid", "provide a devcontainer configuration and sha256 image digest"));
    try {
      this.validate(input.config, input.imageDigest);
      if (input.lockfile !== undefined) {
        const lock = JSON.parse(input.lockfile);
        if (!lock || typeof lock !== "object" || Array.isArray(lock)) return Promise.resolve(fail("invalid", "invalid devcontainer lockfile"));
      }
    } catch (error) { return Promise.resolve(fail("invalid", error instanceof Error ? error.message : "invalid environment configuration")); }
    return once(this.ctx, { requestId: input.requestId, kind: build ? "publish-built-environment" : "publish-environment", subject: { type: "environment", id: input.definitionId ?? input.requestId }, input:build ? {...input,build} : input }, async r => {
      const at = this.ctx.now(), id = input.definitionId ?? this.ctx.newId();
      let definition = await r.definitions.get(id, { lock: true });
      if (!input.definitionId) {
        const created = createDefinition({ id, kind: "environment", name: input.name, at });
        if (!created.ok) return fromRejection(created.error);
        definition = created.value.state;
        await r.definitions.create(definition);
      }
      if (!definition || definition.kind !== "environment") return fail("not-found", "environment definition does not exist");
      const content: EnvironmentContent = { format: "grounds.devcontainer/v1", config: input.config, imageDigest: input.imageDigest, ...(build ? {build} : {}),
        lockfile: input.lockfile ?? null, lockfileDigest: input.lockfile === undefined ? null : "sha256:" + this.ctx.hash(input.lockfile) };
      const published = publishRevision(definition, { revisionId: this.ctx.newId(), expectedSeq: input.expectedSeq, at, content }, this.ctx.hash);
      if (!published.ok) return fromRejection(published.error);
      await r.definitions.save({ ...published.value.state, name: input.name }, definition.version);
      await r.definitions.addRevision(published.value.outcome);
      const revision = published.value.outcome;
      return succeed({ environmentId: id, revisionId: revision.id, seq: revision.seq, digest: revision.digest });
    });
  }

  async show(id: string, seq: number) {
    return this.ctx.units.run("read", async r => {
      const revision = await r.definitions.getRevisionBySeq(id, seq);
      if (!revision || revision.kind !== "environment") return fail("not-found", "environment revision does not exist");
      return succeed({ revision: refOf(revision), content: revision.content });
    });
  }
}

export async function runEnvironment(r: WorkRepositories, revision: Revision, specified?: string): Promise<Outcome<ResolvedEnvironment | undefined>> {
  const task = parseTaskContent(revision.content);
  if (!task.ok) return fromRejection(task.error);
  const id = task.value.environmentDefinitionId;
  if (!id) return specified !== undefined ? fail("invalid", "task has no environment requirement") : succeed(undefined);
  const selected = specified === undefined ? await r.definitions.latestRevision(id) : await r.definitions.getRevision(id, specified);
  if (!selected || selected.kind !== "environment") return fail("not-found", "no matching revision of the required environment");
  return resolveEnvironment(task.value, refOf(selected), specified === undefined ? "latest" : "specified");
}
