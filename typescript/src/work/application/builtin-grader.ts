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
  return ensureBuiltin(r, hash, at, BUILTIN_VERIFICATION_GRADER, "Independent verification", BUILTIN_VERIFICATION_GRADER_CONTENT);
}

export const FILE_MATCH_GRADER = { definitionId: "builtin.file-match", revisionId: "builtin.file-match.r1" };
export const FILE_MATCH_CONTENT = { strategy: "rule", scale: { form: "category", categories: ["match", "mismatch"] }, operation: "equal-file-bytes" } as const;

export function ensureFileMatchGrader(r: WorkRepositories, hash: Hasher, at: Timestamp) {
  return ensureBuiltin(r, hash, at, FILE_MATCH_GRADER, "Exact file match", { ...FILE_MATCH_CONTENT, scale: { form: "category", categories: [...FILE_MATCH_CONTENT.scale.categories] } });
}

async function ensureBuiltin(r: WorkRepositories, hash: Hasher, at: Timestamp, identity: {definitionId: string; revisionId: string}, name: string, content: import("../domain/index.js").JsonValue): Promise<Outcome<RevisionRef>> {
  const existing = await r.definitions.getRevision(identity.definitionId, identity.revisionId);
  const expected = digestOf(content, hash);
  if (!expected.ok) return fromRejection(expected.error);
  if (existing) return existing.digest === expected.value ? succeed(refOf(existing)) : fail("conflict", "the built-in grader was changed");
  if (await r.definitions.get(identity.definitionId)) return fail("conflict", "the built-in grader has no first revision");
  const created = createDefinition({ id: identity.definitionId, kind: "grader", name, at });
  if (!created.ok) return fromRejection(created.error);
  const published = publishRevision(created.value.state, { revisionId: identity.revisionId, expectedSeq: 0, content, at }, hash);
  if (!published.ok) return fromRejection(published.error);
  await r.definitions.create(created.value.state);
  await r.definitions.save(published.value.state, created.value.state.version);
  await r.definitions.addRevision(published.value.outcome);
  return succeed(refOf(published.value.outcome));
}
