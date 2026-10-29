import { existsSync, mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { indexCandidateChanges, matchChangeLine } from "./change-index.js";
import type { Module } from "./module.js";
import type { DeliveryProof, DeliveryUnit } from "./delivery-link.js";
import { baselineUnavailable, validation, worktreeMismatch } from "./errors.js";
import { validDeliveryReceipt } from "./delivery-worktree.js";

export { rawOID, withHistoryRead, assertHistoryBudget, historyBytes, historyGit, assertHistoryRepository } from "./git-history-read.js";
import { rawOID, historyBytes, historyGit, assertHistoryRepository, assertHistoryBudget } from "./git-history-read.js";

export async function candidateFromReceipt(module: Module, cwd: string, repositoryId: string, databaseId: string): Promise<string> {
  const path = resolve(cwd, historyGit(cwd, ["rev-parse", "--git-path", "grounds-delivery.json"]));
  if (!existsSync(path)) throw validation("candidate", "requires an explicit Candidate or a valid delivery receipt");
  if (statSync(path).size > 64 * 1024) throw worktreeMismatch("", "Delivery receipt exceeds its size limit");
  let receipt: unknown;
  try { receipt = JSON.parse(readFileSync(path, "utf8")); } catch { throw worktreeMismatch("", "Delivery receipt is invalid"); }
  if (!validDeliveryReceipt(receipt) || receipt.database_id !== databaseId || receipt.repository_id !== repositoryId) throw worktreeMismatch("", "Delivery receipt identity does not match this ledger and Repository");
  const { record, issue, repository_id } = await module.historyCandidate(receipt.candidate_id);
  if (repository_id !== repositoryId || receipt.baseline_oid !== (record.candidate.base_commit ?? issue.baseline.git_oid) || receipt.result_tree_oid !== record.candidate.result_tree_oid || receipt.patch_digest !== record.candidate.patch_digest || receipt.issue.id !== issue.issue_id || receipt.issue.version !== issue.revision_number) throw worktreeMismatch(receipt.candidate_id, "Delivery receipt does not match the immutable Candidate");
  return receipt.candidate_id;
}

export function assertNoHistoryFilters(cwd: string): void {
  const paths = historyGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (!paths) return;
  const attrs = historyGit(cwd, ["check-attr", "-z", "--stdin", "filter", "working-tree-encoding"], Buffer.from(paths)).split("\0");
  for (let i = 0; i + 2 < attrs.length; i += 3) if (attrs[i + 2] !== "unspecified" && attrs[i + 2] !== "unset") throw worktreeMismatch("", "History tracing does not execute clean filters or working-tree encoding conversions");
}

export function historyBlob(cwd: string, commit: string, path: string): string {
  const entry = historyGit(cwd, ["ls-tree", "-z", commit, "--", path]);
  if (!entry) return "";
  const header = /^(100[0-7]{3}) blob ([0-9a-f]+)\t/.exec(entry);
  if (!header) throw baselineUnavailable("History location is not a regular source file");
  const bytes = historyBytes(cwd, ["cat-file", "blob", header[2]]);
  if (bytes.length > 2 * 1024 * 1024) throw baselineUnavailable("history_file_size_budget exhausted");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw baselineUnavailable("History source is not UTF-8 text"); }
}

export const sourceLines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Map only line pairs present in every optimal order-preserving alignment.
 * null means introduced text; undefined means ambiguous or beyond the budget.
 */
export function uniqueLineMap(oldText: string, newText: string): Array<number | null | undefined> {
  assertHistoryBudget();
  const a = sourceLines(oldText), b = sourceLines(newText);
  if (oldText === newText) return b.map((_, i) => i + 1);
  const n = a.length, m = b.length, width = m + 1;
  if ((n + 1) * width > 2_000_000) return b.map(() => undefined);
  const p = new Uint32Array((n + 1) * width), q = new Uint32Array((n + 1) * width);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) p[(i + 1) * width + j + 1] = a[i] === b[j] ? p[i * width + j] + 1 : Math.max(p[i * width + j + 1], p[(i + 1) * width + j]);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) q[i * width + j] = a[i] === b[j] ? q[(i + 1) * width + j + 1] + 1 : Math.max(q[(i + 1) * width + j], q[i * width + j + 1]);
  const length = q[0];
  return b.map((line, j) => {
    const matches: number[] = []; let skippable = false;
    for (let i = 0; i <= n; i++) {
      if (p[i * width + j] + q[i * width + j + 1] === length) skippable = true;
      if (i < n && a[i] === line && p[i * width + j] + 1 + q[(i + 1) * width + j + 1] === length) matches.push(i + 1);
    }
    return matches.length === 0 ? null : matches.length === 1 && !skippable ? matches[0] : undefined;
  });
}

export function lineAtCommit(cwd: string, head: string, target: string, path: string, line: number): number | undefined {
  let commit = head, mapped: number | null | undefined = line;
  for (let edges = 0; edges < 1000; edges++) {
    if (commit === target) return mapped ?? undefined;
    const parents = historyGit(cwd, ["rev-list", "--parents", "-n", "1", commit]).split(" ");
    if (parents.length !== 2) return undefined;
    const parent = parents[1];
    const before = historyBlob(cwd, parent, path);
    mapped = uniqueLineMap(before, historyBlob(cwd, commit, path))[mapped! - 1];
    if (mapped == null) return undefined;
    commit = parent;
  }
  return undefined;
}

export function lineOrigin(cwd: string, head: string, path: string, line: number): { commit: string; line: number } | undefined {
  let commit = head, mapped = line;
  for (let edges = 0; edges < 1000; edges++) {
    const parents = historyGit(cwd, ["rev-list", "--parents", "-n", "1", commit]).split(" ");
    if (parents.length === 1) return { commit, line: mapped };
    if (parents.length !== 2) return undefined;
    const before = historyBlob(cwd, parents[1], path);
    const older = uniqueLineMap(before, historyBlob(cwd, commit, path))[mapped - 1];
    if (older === null) {
      const changes = historyGit(cwd, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--find-renames=50%", "--find-copies=50%", parents[1], commit]).split("\0");
      for (let i = 0; i < changes.length && changes[i];) {
        const status = changes[i++];
        if (/^[RC]/.test(status)) { i++; if (changes[i++] === path) return undefined; }
        else i++;
      }
      return { commit, line: mapped };
    }
    if (older === undefined) return undefined;
    mapped = older; commit = parents[1];
  }
  return undefined;
}

export async function deliveryProof(module: Module, cwd: string, repositoryId: string, candidateId: string, commit: string): Promise<DeliveryProof> {
  assertHistoryRepository(cwd);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) throw validation("commit", "requires a full commit OID");
  if (historyGit(cwd, ["cat-file", "-t", commit]) !== "commit") throw validation("commit", "requires a commit object, not a tag, tree or blob");
  const parents = historyGit(cwd, ["rev-list", "--parents", "-n", "1", commit]).split(" ");
  if (parents.length !== 2) throw validation("commit", "requires a commit with exactly one parent");
  const { record, issue, repository_id } = await module.historyCandidate(candidateId);
  if (repository_id !== repositoryId) throw validation("candidate", "belongs to another Repository");
  try { historyBytes(cwd, ["cat-file", "-e", rawOID(record.artifact.result_tree_oid)]); }
  catch {
    const temporary = mkdtempSync(join(tmpdir(), "grounds-history-index-"));
    const index = join(temporary, "index");
    try {
      historyBytes(cwd, ["read-tree", rawOID(record.candidate.base_commit ?? issue.baseline.git_oid)], undefined, index);
      historyBytes(cwd, ["apply", "--cached", "--binary", "--whitespace=nowarn"], record.artifact.patch, index);
      const tree = historyBytes(cwd, ["write-tree"], undefined, index).toString("utf8").trim();
      if (tree !== rawOID(record.artifact.result_tree_oid)) throw worktreeMismatch(candidateId, "Candidate reconstruction differs from its result tree");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  const parent = parents[1];
  const exact = (record.candidate.base_commit ? parent === rawOID(record.candidate.base_commit) : historyGit(cwd, ["rev-parse", `${parent}^{tree}`]) === historyGit(cwd, ["rev-parse", `${rawOID(issue.baseline.git_oid)}^{tree}`])) && historyGit(cwd, ["rev-parse", `${commit}^{tree}`]) === rawOID(record.artifact.result_tree_oid);
  const units: DeliveryUnit[] = [];
  for (const u of indexCandidateChanges(record.artifact).change_units) {
    if (u.kind !== "hunk" || !u.new_range || !u.old_range || u.change === "renamed" || u.change === "copied") continue;
    const path = Buffer.from(u.path_bytes, "base64").toString("utf8");
    let commitStart = u.new_range.start;
    if (!exact) {
      const baseline = historyBlob(cwd, rawOID(record.candidate.base_commit ?? issue.baseline.git_oid), path), result = historyBlob(cwd, rawOID(record.artifact.result_tree_oid), path);
      const old = historyBlob(cwd, parent, path), current = historyBlob(cwd, commit, path);
      // An empty blob is not the same old state as an absent file.
      if (!u.old_range.lines && Boolean(historyGit(cwd, ["ls-tree", "-z", rawOID(record.candidate.base_commit ?? issue.baseline.git_oid), "--", path])) !== Boolean(historyGit(cwd, ["ls-tree", "-z", parent, "--", path]))) continue;
      if (!u.new_range.lines && Boolean(historyGit(cwd, ["ls-tree", "-z", rawOID(record.artifact.result_tree_oid), "--", path])) !== Boolean(historyGit(cwd, ["ls-tree", "-z", commit, "--", path]))) continue;
      if (!u.old_range.lines && !baseline && old) continue;
      if (!u.new_range.lines && !result && current) continue;
      const oldMap = uniqueLineMap(old, baseline), newMap = uniqueLineMap(current, result);
      const introduced = uniqueLineMap(old, current), removed = uniqueLineMap(current, old);
      let valid = true;
      for (const side of ["old", "new"] as const) {
        const range = side === "old" ? u.old_range : u.new_range;
        const map = side === "old" ? oldMap : newMap;
        let previous: number | undefined;
        for (let line = range.start; line < range.start + range.lines; line++) {
          const mapped = map[line - 1];
          if (mapped == null || (previous !== undefined && mapped !== previous + 1)) { valid = false; break; }
          const status = matchChangeLine(record.artifact, [u], line, side).status;
          if ((status === "added" && introduced[mapped - 1] !== null) || (status === "deleted" && removed[mapped - 1] !== null)) { valid = false; break; }
          previous = mapped;
        }
      }
      const emptyBoundary = (side: "old" | "new"): number | undefined => {
        const range = side === "old" ? u.old_range! : u.new_range!;
        const changed = side === "old" ? u.new_range! : u.old_range!;
        const sourceCount = sourceLines(side === "old" ? baseline : result).length;
        const actualCount = sourceLines(side === "old" ? old : current).length;
        const otherCount = sourceLines(side === "old" ? current : old).length;
        const map = side === "old" ? oldMap : newMap;
        const changedMap = side === "old" ? newMap : oldMap;
        const toOther = side === "old" ? removed : introduced;
        if (range.start < 0 || range.start > sourceCount || !changed.lines) return undefined;
        const left = range.start === 0 ? 0 : map[range.start - 1];
        const right = range.start === sourceCount ? actualCount + 1 : map[range.start];
        if (left == null || right == null || right !== left + 1) return undefined;
        const changedStart = changedMap[changed.start - 1];
        const leftOther = left === 0 ? 0 : toOther[left - 1];
        const rightOther = right === actualCount + 1 ? otherCount + 1 : toOther[right - 1];
        return changedStart != null && leftOther === changedStart - 1 && rightOther === changedStart + changed.lines ? left : undefined;
      };
      if (!valid || (!u.old_range.lines && emptyBoundary("old") === undefined)) continue;
      const mappedStart = u.new_range.lines ? newMap[u.new_range.start - 1] : emptyBoundary("new");
      if (mappedStart == null) continue;
      commitStart = mappedStart;
    }
    units.push({ change_unit_id: u.change_unit_id, path, candidate_start: u.new_range.start, commit_start: commitStart, lines: u.new_range.lines });
  }
  if (!units.length) throw validation("commit", "no supported text changes");
  return { candidate_id: candidateId, repository_id: repositoryId, commit_oid: commit, parent_oid: parent, patch_digest: record.candidate.patch_digest, method: "raw-double-sided/v1", content: exact ? "exact_artifact" : "exact_scope", units };
}
