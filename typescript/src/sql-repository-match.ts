import { repositoryMatchKey } from "./git.js";
import { DomainError } from "./errors.js";
import { asText } from "./sql-shared.js";
import type { SQLClient } from "./sql-client.js";
import type { RepositoryRemoteBinding } from "./store-types.js";

/** Transport-agnostic Repository matching, factored out of the transaction core
 * so that module stays within its size budget.  The active remote list is read
 * once and passed in, so a caller keeps its scan and any following write in the
 * same transaction. */

/** One read of every active remote (canonical and alias).  Retired aliases are
 * excluded: they keep history and must not match by key. */
export const readActiveRepositoryRemoteBindings = async (client: SQLClient): Promise<RepositoryRemoteBinding[]> => {
  const rows = await client.all<{ repository_id: unknown; remote: unknown }>("SELECT repository_id, remote FROM repository_remotes WHERE state = 'active' ORDER BY repository_id, remote LIMIT 100001");
  if (rows.length > 100000) throw new DomainError("ARTIFACT_TOO_LARGE", "Repository remote list exceeds 100,000 entries");
  return rows.map((row) => ({ repository_id: asText(row.repository_id), remote: asText(row.remote) }));
};

/** Repository ids whose active remotes share `remote`'s match key. */
export const repositoryIdsByMatchKey = (bindings: readonly RepositoryRemoteBinding[], remote: string): string[] => {
  const key = repositoryMatchKey(remote);
  if (key === undefined) return [];
  const ids = new Set<string>();
  for (const binding of bindings) if (repositoryMatchKey(binding.remote) === key) ids.add(binding.repository_id);
  return [...ids];
};

/** Whether another Repository already uses `remote`'s key.  The same key owned
 * by `repositoryId` itself is redundant, and retired aliases are absent from
 * `bindings`, so neither is a conflict. */
export const hasForeignKeyConflict = (bindings: readonly RepositoryRemoteBinding[], repositoryId: string, remote: string): boolean => {
  const key = repositoryMatchKey(remote);
  if (key === undefined) return false;
  return bindings.some((binding) => binding.repository_id !== repositoryId && repositoryMatchKey(binding.remote) === key);
};
