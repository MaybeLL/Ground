import { digestOf, type Hasher, type Id, type JsonValue, type Timestamp } from "../domain/index.js";
import { StorageFailure, type WorkRepositories, type WorkUnitOfWork } from "../ports/index.js";
import { fail, failureOf, succeed, type Outcome } from "./outcome.js";

/** Thrown inside a unit to undo everything it wrote when the use case ends in a failure the caller can act on. */
class Abandon extends Error { constructor(readonly outcome: Outcome<never>) { super("abandoned"); } }

export interface RequestContext {
  readonly units: WorkUnitOfWork;
  readonly hash: Hasher;
  readonly now: () => Timestamp;
  readonly newId: () => Id;
}

/**
 * Run a use case once per request identity.
 *
 * The same identity with the same input returns what the first call returned;
 * with other input it is a conflict. A failure is not remembered: nothing is
 * written, so the caller may fix the situation and ask again under the same
 * identity. The intent is written in the same transaction as the effect, so a
 * request is either fully applied and remembered or not applied at all.
 */
export async function once<T extends JsonValue>(
  context: RequestContext,
  request: { requestId: string; kind: string; input: JsonValue; subject: { type: string; id: Id } },
  effect: (repositories: WorkRepositories) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
  const digest = digestOf({ kind: request.kind, input: request.input }, context.hash);
  if (!digest.ok) return fail("invalid", digest.error.message);
  for (let attempt = 0; ; attempt++) {
    try {
      return await context.units.run("write", async repositories => {
        const earlier = await repositories.intents.findByRequest(request.requestId);
        if (earlier) {
          if (earlier.requestHash !== digest.value) return fail("request-conflict", `request ${request.requestId} was already used with different input`);
          return succeed(earlier.result as T);
        }
        const outcome = await effect(repositories);
        if (!outcome.ok) throw new Abandon(outcome);
        const at = context.now();
        await repositories.intents.register({ id: context.newId(), requestId: request.requestId, requestHash: digest.value, kind: request.kind, subject: request.subject, state: "completed", payload: request.input, result: outcome.value, createdAt: at, updatedAt: at, version: 1 });
        return outcome;
      });
    } catch (error) {
      if (error instanceof Abandon) return error.outcome;
      // A concurrent identical request registered first: the next pass replays its result.
      if (error instanceof StorageFailure && error.reason === "duplicate" && attempt === 0) continue;
      const failure = failureOf(error);
      if (failure) return { ok: false, error: failure };
      throw error;
    }
  }
}
