import { createDefinition, digestOf, publishRevision, refOf, type Hasher, type RevisionRef, type Timestamp } from "../domain/index.js";
import type { WorkRepositories } from "../ports/index.js";
import { fail, fromRejection, succeed, type Outcome } from "./outcome.js";

/** Named so the ledger's request-order counter for gradings has one name everywhere. */

/**
 * The one grader behind independent acceptance: an evaluator that judges every
 * criterion of the task, blind first and then against the delivery's claims.
 */
export const BUILTIN_VERIFICATION_GRADER = { definitionId: "builtin.independent-verification", revisionId: "builtin.independent-verification.r1" } as const;
export const BUILTIN_VERIFICATION_GRADER_CONTENT = { strategy: "agent", scale: { form: "criteria" } } as const;

/** The built-in grader's revision, created on first use. A different definition under the same id is a conflict, not something to overwrite. */
export async function ensureVerificationGrader(r: WorkRepositories, hash: Hasher, at: Timestamp): Promise<Outcome<RevisionRef>> {
  const existing = await r.definitions.getRevision(BUILTIN_VERIFICATION_GRADER.definitionId, BUILTIN_VERIFICATION_GRADER.revisionId);
  const expected = digestOf(BUILTIN_VERIFICATION_GRADER_CONTENT, hash);
  if (!expected.ok) return fromRejection(expected.error);
  if (existing) return existing.digest === expected.value ? succeed(refOf(existing)) : fail("conflict", "the built-in verification grader was changed");
  if (await r.definitions.get(BUILTIN_VERIFICATION_GRADER.definitionId)) return fail("conflict", "the built-in verification grader has no first revision");
  const created = createDefinition({ id: BUILTIN_VERIFICATION_GRADER.definitionId, kind: "grader", name: "Independent verification", at });
  if (!created.ok) return fromRejection(created.error);
  const published = publishRevision(created.value.state, { revisionId: BUILTIN_VERIFICATION_GRADER.revisionId, expectedSeq: 0, content: BUILTIN_VERIFICATION_GRADER_CONTENT, at }, hash);
  if (!published.ok) return fromRejection(published.error);
  await r.definitions.create(created.value.state);
  await r.definitions.save(published.value.state, created.value.state.version);
  await r.definitions.addRevision(published.value.outcome);
  return succeed(refOf(published.value.outcome));
}
