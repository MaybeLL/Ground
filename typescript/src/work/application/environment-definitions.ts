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
};

/** Preserve the exact devcontainer source (including JSONC comments) and the
 * lockfile alongside the immutable identity of the image chosen for this environment. */
export class EnvironmentDefinitions {
  constructor(private readonly ctx: RequestContext) {}

  publish(input: { requestId: string; name: string; config: string; imageDigest: string; lockfile?: string; definitionId?: string; expectedSeq: number }) {
    if (!isId(input.requestId) || !isText(input.name, 256) || !isText(input.config, 1024 * 1024) || !isDigest(input.imageDigest) ||
        (input.lockfile !== undefined && !isText(input.lockfile, 1024 * 1024))) return Promise.resolve(fail("invalid", "provide a devcontainer configuration and sha256 image digest"));
    return once(this.ctx, { requestId: input.requestId, kind: "publish-environment", subject: { type: "environment", id: input.definitionId ?? input.requestId }, input }, async r => {
      const at = this.ctx.now(), id = input.definitionId ?? this.ctx.newId();
      let definition = await r.definitions.get(id, { lock: true });
      if (!input.definitionId) {
        const created = createDefinition({ id, kind: "environment", name: input.name, at });
        if (!created.ok) return fromRejection(created.error);
        definition = created.value.state;
        await r.definitions.create(definition);
      }
      if (!definition || definition.kind !== "environment") return fail("not-found", "environment definition does not exist");
      const content: EnvironmentContent = { format: "grounds.devcontainer/v1", config: input.config, imageDigest: input.imageDigest,
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
