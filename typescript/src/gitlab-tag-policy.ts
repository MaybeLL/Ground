import { apiID, apiRecord, GitLabFailure } from "./gitlab-api.js";

export const ARCHIVE_NAMESPACES = ["refs/tags/grounds/candidates/", "refs/tags/grounds/deliveries/"] as const;
export type ArchiveNamespace = typeof ARCHIVE_NAMESPACES[number];
export interface GitLabGrant { access_level: number | null; user_id?: number; group_id?: number; deploy_key_id?: number }
export interface GitLabTagRule { name: string; create_access_levels: GitLabGrant[] }
export interface GitLabActor { id: number; username: string; access_level: number }
export interface NamespacePolicy {
  ref_namespace: ArchiveNamespace;
  tag_pattern: string;
  protection: "confirmed" | "missing";
  current_user_can_create: boolean | "unknown";
  developer_can_create: boolean | "unknown";
  ordinary_developer_cannot_update: boolean;
  ordinary_developer_cannot_delete: boolean;
  maintainer_delete: "explicit_gitlab_ui_or_api" | "forbidden_by_ruleset";
  matches: { rule: GitLabTagRule; coverage: "whole_namespace" | "partial_namespace" }[];
  default_difference: "recommended" | "stricter_or_custom" | "missing";
}

export function decodeTagRules(value: unknown[]): GitLabTagRule[] {
  if (value.length > 1000) throw new GitLabFailure("invalid_response");
  const names = new Set<string>();
  let grants = 0;
  return value.map(item => {
    const row = apiRecord(item);
    if (typeof row.name !== "string" || !row.name || row.name.length > 255 || /[\x00-\x20\x7f?\[\\]/.test(row.name) || names.has(row.name)) throw new GitLabFailure("invalid_response");
    names.add(row.name);
    if (!Array.isArray(row.create_access_levels) || row.create_access_levels.length === 0 || row.create_access_levels.length > 1000) throw new GitLabFailure("invalid_response");
    grants += row.create_access_levels.length;
    if (grants > 4096) throw new GitLabFailure("policy_too_complex");
    return { name: row.name, create_access_levels: row.create_access_levels.map(item => {
      const grant = apiRecord(item);
      const result: GitLabGrant = { access_level: grant.access_level as number | null };
      for (const key of ["user_id", "group_id", "deploy_key_id"] as const) if (grant[key] !== undefined && grant[key] !== null) result[key] = apiID(grant[key]);
      const identities = [result.user_id, result.group_id, result.deploy_key_id].filter(v => v !== undefined).length;
      // GitLab returns null access_level for explicit user/group grants. Keep
      // that fact without turning null into a role grant or accepting no identity.
      // GitLab EE can persist ADMIN (60) in protected ref rules. Preserve it
      // even on unrelated rules; it grants no ordinary project role access.
      const validLevel = [0, 30, 40, 50, 60].includes(grant.access_level as number) || identities === 1 && grant.access_level === null;
      if (identities > 1 || !validLevel) throw new GitLabFailure("invalid_response");
      return result;
    }) };
  });
}

/** GitLab combines overlapping protected-tag create permissions with OR. A
 * No-one rule does not subtract another rule's allow. Protection itself stops
 * Git updates/deletes; Maintainer/Owner deletion is a separate UI/API action.
 *
 * Check the entire supported archive ID language, not a sample UUID. Each glob
 * is a small NFA; the product traversal visits every distinct matching region.
 * Literal rules and arbitrary overlapping '*' patterns therefore cannot hide a
 * hole. The bound fails closed instead of sampling when a policy is too complex.
 */
const firstChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const restChars = firstChars + "_-";
function closure(pattern: string, states: Set<number>): Set<number> {
  const result = new Set(states);
  for (const pos of result) if (pattern[pos] === "*") result.add(pos + 1);
  return result;
}
function advance(pattern: string, states: Set<number>, char: string): Set<number> {
  const next = new Set<number>();
  for (const pos of closure(pattern, states)) {
    if (pattern[pos] === "*") next.add(pos);
    else if (pattern[pos] === char) next.add(pos + 1);
  }
  return closure(pattern, next);
}
function initial(pattern: string, prefix: string): Set<number> {
  let states = closure(pattern, new Set([0]));
  for (const char of prefix) states = advance(pattern, states, char);
  return states;
}
const key = (states: Set<number>[]): string => states.map(set => [...set].sort((a, b) => a - b).join(",")).join(";");
type Permission = boolean | "unknown";
function rulePermission(rule: GitLabTagRule, actor: GitLabActor, groups: ReadonlyMap<number, Permission>): Permission {
  if (actor.access_level < 30) return false;
  let unknown = false;
  for (const grant of rule.create_access_levels) {
    if (grant.user_id !== undefined) { if (grant.user_id === actor.id) return true; }
    else if (grant.group_id !== undefined) {
      const member = groups.get(grant.group_id) ?? "unknown";
      if (member === true) return true;
      if (member === "unknown") unknown = true;
    } else if (grant.deploy_key_id === undefined && grant.access_level !== null && grant.access_level > 0 && actor.access_level >= grant.access_level) return true;
  }
  return unknown ? "unknown" : false;
}

export function evaluateNamespace(namespace: ArchiveNamespace, rules: GitLabTagRule[], actor: GitLabActor, groups: ReadonlyMap<number, Permission> = new Map()): NamespacePolicy {
  const prefix = namespace.slice("refs/tags/".length);
  // Drop states that can no longer match even before considering the suffix.
  const relevant = rules.map(rule => ({ rule, states: initial(rule.name, prefix) })).filter(item => item.states.size);
  if (relevant.length > 100) throw new GitLabFailure("policy_too_complex");
  const patterns = relevant.map(item => item.rule.name);
  const current = relevant.map(item => rulePermission(item.rule, actor, groups));
  // The generic Developer has no special user/group/deploy-key grant. A
  // particular Developer's extra grants are reflected only in current_user.
  const developer = relevant.map(item => item.rule.create_access_levels.some(grant => grant.user_id === undefined && grant.group_id === undefined && grant.deploy_key_id === undefined && grant.access_level === 30));
  const queue: Set<number>[][] = [];
  const seen = new Set<string>();
  let retainedStateUnits = 0;
  const add = (states: Set<number>[]) => {
    const k = key(states);
    if (!seen.has(k)) {
      retainedStateUnits += states.reduce((sum, state) => sum + 4 + state.size, 0);
      if (retainedStateUnits > 150_000 || queue.length >= 2000) throw new GitLabFailure("policy_too_complex");
      seen.add(k); queue.push(states);
    }
  };
  for (const char of firstChars) add(relevant.map(item => advance(item.rule.name, item.states, char)));
  let protectedAll = true, actorAll: Permission = true, developerAll = true;
  const matchSome = patterns.map(() => false), matchAll = patterns.map(() => true);
  for (let index = 0; index < queue.length; index++) {
    const states = queue[index]!;
    const matching = states.map((state, i) => state.has(patterns[i]!.length));
    let permitted: Permission = false, dev = false, protectedHere = false;
    for (let i = 0; i < matching.length; i++) {
      matchAll[i] = matchAll[i]! && matching[i]!;
      matchSome[i] = matchSome[i]! || matching[i]!;
      if (!matching[i]) continue;
      protectedHere = true;
      if (current[i] === true) permitted = true;
      else if (current[i] === "unknown" && permitted === false) permitted = "unknown";
      dev ||= developer[i]!;
    }
    protectedAll &&= protectedHere;
    developerAll &&= dev;
    if (permitted === false) actorAll = false;
    else if (permitted === "unknown" && actorAll === true) actorAll = "unknown";
    for (const char of restChars) add(states.map((state, i) => advance(patterns[i]!, state, char)));
  }
  return {
    ref_namespace: namespace, tag_pattern: prefix + "*", protection: protectedAll ? "confirmed" : "missing",
    current_user_can_create: actorAll, developer_can_create: developerAll,
    ordinary_developer_cannot_update: protectedAll, ordinary_developer_cannot_delete: protectedAll,
    maintainer_delete: "explicit_gitlab_ui_or_api",
    matches: relevant.flatMap((item, i) => matchSome[i] ? [{ rule: item.rule, coverage: matchAll[i] ? "whole_namespace" as const : "partial_namespace" as const }] : []),
    default_difference: !protectedAll ? "missing" : developerAll ? "recommended" : "stricter_or_custom",
  };
}
