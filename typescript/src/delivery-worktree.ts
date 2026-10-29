import { inspectCandidateSource } from "./development-branch.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { captureArtifact, captureCommittedArtifact, discoverRepository } from "./git.js";
import { withIsolatedGitObjects } from "./git-command.js";
import { DomainError, worktreeMismatch } from "./errors.js";
import { isGitOID, isUUIDv7 } from "./identity.js";
import type { DeliveryReceipt, SelectionResult } from "./selection.js";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
const present = (path: string): boolean => { try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } };
const canonical = (path: string): string => present(path) ? realpathSync(path) : join(canonical(dirname(path)), path.slice(dirname(path).length + 1));
const atomic = (path: string, value: unknown): void => {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 }); renameSync(tmp, path); }
  finally { if (present(tmp)) rmSync(tmp); }
};
const equal = (a: DeliveryReceipt, b: DeliveryReceipt): boolean => Object.keys(a).every(k => k === "issue" ? a.issue.id === b.issue.id && a.issue.version === b.issue.version : a[k as keyof DeliveryReceipt] === b[k as keyof DeliveryReceipt]);
export const validDeliveryReceipt = (x: unknown): x is DeliveryReceipt => {
  if (!x || typeof x !== "object" || Array.isArray(x)) return false;
  const r = x as DeliveryReceipt;
  return Object.keys(r).filter(k => !["observed_target_commit", "delivery_decision_id"].includes(k)).sort().join() === (r.format === "grounds.delivery-worktree/v2" ? "baseline_oid,candidate_id,database_id,format,issue,patch_digest,repository_id,result_tree_oid,selection_id,selection_version,source_commit" : "baseline_oid,candidate_id,database_id,format,issue,patch_digest,repository_id,result_tree_oid,selection_id,selection_version")
    && (r.observed_target_commit === undefined || (r.format === "grounds.delivery-worktree/v2" && isGitOID(r.observed_target_commit)))
    && (r.delivery_decision_id === undefined || (r.format === "grounds.delivery-worktree/v2" && isUUIDv7(r.delivery_decision_id)))
    && (r.format === "patchledger.delivery-worktree/v1" || (r.format === "grounds.delivery-worktree/v2" && isGitOID(r.source_commit))) && [r.database_id, r.candidate_id, r.repository_id, r.selection_id].every(isUUIDv7)
    && !!r.issue && Object.keys(r.issue).sort().join() === "id,version" && isUUIDv7(r.issue.id) && Number.isSafeInteger(r.issue.version) && r.issue.version > 0
    && Number.isSafeInteger(r.selection_version) && r.selection_version > 0 && isGitOID(r.baseline_oid) && isGitOID(r.result_tree_oid)
    && typeof r.patch_digest === "string" && /^sha256:[a-f0-9]{64}$/.test(r.patch_digest);
};
interface RecordState { format: "patchledger.local-delivery/v1"; target_path: string; branch: string; receipt: DeliveryReceipt; stage: "planned" | "created" | "applied" | "complete" }
export interface DeliveryInspection {
  target_path: string;
  status: "not_found" | "incomplete" | "ready" | "missing" | "changed" | "invalid";
  receipt?: DeliveryReceipt;
  branch?: string;
  selection_changed: boolean;
  reason: string;
  next_action: "prepare_delivery" | "resume_preparation" | "continue_delivery" | "review_selection" | "inspect_manually" | "prepare_new_path";
  recommended_argv: string[];
}

/** Local coordination only; the ledger owns Selection and immutable artifacts. */
export class DeliveryWorktreeModule {
  readonly source: string;
  readonly common: string;
  readonly root: string;
  constructor(source: string, private readonly databaseID: string) {
    this.source = discoverRepository(source).root;
    this.common = realpathSync(resolve(this.source, git(this.source, "rev-parse", "--git-common-dir")));
    this.root = join(this.common, "grounds-deliveries");
  }
  private recordPath(target: string): string { return join(this.root, createHash("sha256").update(target).digest("hex") + ".json"); }
  private readJSON(path: string): unknown {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 65536) throw new Error("metadata must be a bounded regular file");
    return JSON.parse(readFileSync(path, "utf8"));
  }
  private record(target: string): RecordState | undefined {
    const path = this.recordPath(target);
    if (!present(path)) return undefined;
    const r = this.readJSON(path) as RecordState;
    if (!r || Object.keys(r).sort().join() !== "branch,format,receipt,stage,target_path" || r.format !== "patchledger.local-delivery/v1" || r.target_path !== target || typeof r.branch !== "string" || !r.branch || [...r.branch].length > 1024 || !["planned", "created", "applied", "complete"].includes(r.stage) || !validDeliveryReceipt(r.receipt)) throw new Error("invalid local delivery record");
    return r;
  }
  private receiptPath(target: string): string { return resolve(target, git(target, "rev-parse", "--git-path", "grounds-delivery.json")); }
  private completeReceipt(target: string, receipt: DeliveryReceipt): void {
    const path = this.receiptPath(target);
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
      // Publish an already complete file without replacing any existing entry.
      try { linkSync(temporary, path); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const existing = this.readJSON(path);
        if (!validDeliveryReceipt(existing) || !equal(existing, receipt)) throw new Error("existing receipt conflicts with preparation");
      }
    } finally { if (present(temporary)) rmSync(temporary); }
  }
  private registered(target: string): boolean { return git(this.source, "worktree", "list", "--porcelain", "-z").split("\0").includes(`worktree ${target}`); }
  private branchExists(branch: string): boolean { try { git(this.source, "show-ref", "--verify", `refs/heads/${branch}`); return true; } catch { return false; } }
  private safeRoot(create: boolean): void {
    if (!present(this.root)) { if (create) mkdirSync(this.root, { mode: 0o700 }); else return; }
    if (!lstatSync(this.root).isDirectory() || lstatSync(this.root).isSymbolicLink()) throw new Error("local delivery registry must be a real directory");
  }
  private local(target: string): { status: DeliveryInspection["status"]; reason: string; receipt?: DeliveryReceipt; branch?: string } {
    this.safeRoot(false);
    const r = this.record(target);
    if (r && r.receipt.database_id !== this.databaseID) throw new Error("delivery belongs to another database");
    if (!present(target)) {
      if (!r) return { status: "not_found", reason: "No preparation found in this clone." };
      const resumable = r.stage === "planned" && !this.registered(target) && !this.branchExists(r.branch);
      return { status: resumable ? "incomplete" : "missing", reason: resumable ? "Preparation was recorded before Git creation." : "Recorded worktree is missing; retain existing branches and use a new path.", receipt: r.receipt, branch: r.branch };
    }
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory() || realpathSync(discoverRepository(target).root) !== target || !this.registered(target)
      || realpathSync(resolve(target, git(target, "rev-parse", "--git-common-dir"))) !== this.common) throw new Error("target is not a registered worktree of this clone");
    const p = this.receiptPath(target);
    const receipt = present(p) ? this.readJSON(p) : undefined;
    if (receipt !== undefined && !validDeliveryReceipt(receipt)) throw new Error("invalid delivery receipt");
    const fixed = receipt as DeliveryReceipt | undefined;
    if (fixed && (fixed.database_id !== this.databaseID || (r && !equal(r.receipt, fixed)))) throw new Error("delivery receipt conflicts with preparation or database");
    if (!r && !fixed) throw new Error("unowned directory: no preparation record or valid receipt");
    // A crash inside worktree creation cannot establish ownership merely from matching content.
    if (r?.stage === "planned" && !fixed) throw new Error("Git creation was interrupted before ownership was recorded; inspect manually");
    const expected = fixed ?? r!.receipt;
    if (!expected.source_commit) throw new DomainError("UNSUPPORTED_CANDIDATE_ARTIFACT", "Historical patch-only delivery is unsupported; preserve its local files");
    const branch = git(target, "symbolic-ref", "--short", "HEAD");
    if (r && branch !== r.branch) throw new Error("worktree branch differs from preparation");
    const details = { receipt: expected, branch };
    const algorithm = git(target, "rev-parse", "--show-object-format");
    if (`${algorithm}:${git(target, "rev-parse", "HEAD")}` !== (expected.source_commit ?? expected.baseline_oid) || git(target, "diff", "--cached", "--name-only").length) return { ...details, status: "changed", reason: "HEAD or index changed; preserve user work." };
    // Seed from the fixed source so tracked ignored files stay tracked when
    // staging the current worktree into the temporary inspection index.
    const work = captureArtifact(target, expected.source_commit);
    const artifact = captureCommittedArtifact(target, expected.baseline_oid, expected.source_commit);
    const matches = work.result_tree_oid === expected.result_tree_oid && artifact.result_tree_oid === expected.result_tree_oid && artifact.patch_digest === expected.patch_digest;
    if (matches) return { ...details, status: fixed ? "ready" : "incomplete", reason: fixed ? "Prepared artifact and receipt match." : "Artifact matches; receipt can be completed." };
    if (!fixed && r?.stage === "created" && !git(target, "status", "--porcelain=v1", "--untracked-files=all")) return { ...details, status: "incomplete", reason: "Owned worktree is still at the clean baseline." };
    return { ...details, status: "changed", reason: "Worktree content differs from the fixed Candidate; preserve user work." };
  }
  /** Every delivery target in this clone whose recorded receipt satisfies `match`; unreadable records are surfaced for diagnosis. */
  private discover(match: (receipt: DeliveryReceipt) => boolean): Set<string> | { invalidRoot: string } {
    const targets = new Set<string>();
    try { this.safeRoot(false); }
    catch (e) { return { invalidRoot: String((e as Error).message).slice(0, 4096) }; }
    if (existsSync(this.root)) for (const name of readdirSync(this.root).filter(n => /^[a-f0-9]{64}\.json$/.test(n))) {
      try { const raw = this.readJSON(join(this.root, name)) as RecordState; if (!raw || typeof raw.target_path !== "string" || raw.target_path !== resolve(raw.target_path) || this.recordPath(raw.target_path) !== join(this.root, name)) throw new Error("invalid record locator"); const r = this.record(raw.target_path)!; if (r.receipt.database_id === this.databaseID && match(r.receipt)) targets.add(r.target_path); }
      catch { targets.add(join(this.root, name)); }
    }
    for (const line of git(this.source, "worktree", "list", "--porcelain", "-z").split("\0")) if (line.startsWith("worktree ")) {
      const target = line.slice(9);
      try { const p = this.receiptPath(target); if (present(p)) { const r = this.readJSON(p); if (validDeliveryReceipt(r) && r.database_id === this.databaseID && match(r)) targets.add(target); } } catch { /* explicit path diagnoses unreadable legacy metadata */ }
    }
    return targets;
  }

  /**
   * Read-only status of every delivery target in this clone prepared for one
   * Candidate.  Content checks run against a scratch object store so the
   * clone's own object database is never written.
   */
  inspectCandidate(candidateID: string): Array<{ target_path: string; status: DeliveryInspection["status"]; reason: string; branch?: string }> {
    return withIsolatedGitObjects(this.source, () => {
      const found = this.discover((receipt) => receipt.candidate_id === candidateID);
      if ("invalidRoot" in found) return [{ target_path: this.root, status: "invalid" as const, reason: found.invalidRoot }];
      return [...found].sort().map(raw => {
        let target = raw;
        try { if (present(raw) && lstatSync(raw).isSymbolicLink()) throw new Error("target is a symbolic link"); target = canonical(raw); const local = this.local(target); return { target_path: target, status: local.status, reason: local.reason, ...(local.branch ? { branch: local.branch } : {}) }; }
        catch (e) { return { target_path: target, status: "invalid" as const, reason: String((e as Error).message).slice(0, 4096) }; }
      });
    });
  }

  inspect(selection: SelectionResult, path?: string): DeliveryInspection[] {
    const targets = new Set<string>();
    if (path !== undefined) targets.add(resolve(this.source, path));
    else {
      const found = this.discover((receipt) => receipt.issue.id === selection.issue.id && receipt.issue.version === selection.issue.version);
      if ("invalidRoot" in found) return [{ target_path: this.root, status: "invalid", selection_changed: false, reason: found.invalidRoot, next_action: "inspect_manually", recommended_argv: [] }];
      for (const target of found) targets.add(target);
    }
    return [...targets].sort().map(raw => {
      let target = raw;
      let local: ReturnType<DeliveryWorktreeModule["local"]>;
      try { if (present(raw) && lstatSync(raw).isSymbolicLink()) throw new Error("target is a symbolic link"); target = canonical(raw); local = this.local(target); }
      catch (e) { local = { status: "invalid", reason: String((e as Error).message).slice(0, 4096) }; }
      const r = local.receipt;
      const changed = !!r && (r.issue.id !== selection.issue.id || r.issue.version !== selection.issue.version || r.selection_id !== selection.selection.id || r.selection_version !== selection.selection.version || r.candidate_id !== selection.selection.candidate_id);
      const next = local.status === "invalid" || local.status === "changed" ? "inspect_manually" : changed || selection.selection.state === "unselected" ? "review_selection" : local.status === "ready" ? "continue_delivery" : local.status === "missing" ? "prepare_new_path" : local.status === "incomplete" ? "resume_preparation" : "prepare_delivery";
      const argv = next === "resume_preparation" ? ["selection", "materialize", "--issue", selection.issue.id, "--issue-version", String(selection.issue.version), "--expected-version", String(selection.selection.version), "--path", target, "--branch", local.branch!, "--cwd", this.source] : next === "review_selection" ? ["selection", "show", "--issue", selection.issue.id, "--issue-version", String(selection.issue.version)] : [];
      return { target_path: target, ...local, selection_changed: changed, next_action: next, recommended_argv: argv };
    });
  }
  private async lock<T>(work: () => Promise<T>): Promise<T> {
    this.safeRoot(true);
    const path = join(this.root, "lock"); const started = Date.now();
    while (true) {
      try { mkdirSync(path); atomic(join(path, "owner.json"), { pid: process.pid }); break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        let stale = false;
        try { const owner = this.readJSON(join(path, "owner.json")) as { pid: number }; if (Number.isSafeInteger(owner.pid) && owner.pid > 0) { try { process.kill(owner.pid, 0); } catch (error) { stale = (error as NodeJS.ErrnoException).code === "ESRCH"; } } }
        catch { stale = Date.now() - lstatSync(path).mtimeMs > 60000; }
        if (stale) { try { const retired = `${path}.${process.pid}.stale`; renameSync(path, retired); rmSync(retired, { recursive: true }); } catch {} continue; }
        if (Date.now() - started > 5000) throw new Error("another process is preparing delivery; inspect and retry");
        await new Promise(r => setTimeout(r, 25));
      }
    }
    try { return await work(); } finally { rmSync(path, { recursive: true }); }
  }
  async prepare(targetInput: string, branch: string, load: () => Promise<{ source?: import("./development-branch.js").SourceIdentity; receipt: DeliveryReceipt; patch: Buffer; warnings: { code: string; message: string }[] }>) {
    let target = resolve(this.source, targetInput);
    try {
      if (!targetInput.trim() || [...target].length > 32768 || !branch || [...branch].length > 1024) throw new Error("invalid target path or branch");
      if (present(target) && lstatSync(target).isSymbolicLink()) throw new Error("target must not be a symbolic link");
      target = canonical(target);
      return await this.lock(async () => {
        // Read current Selection under the local lock, before any worktree mutation.
        const { receipt, source, warnings } = await load();
        if (!receipt.source_commit || !source) throw new DomainError("UNSUPPORTED_CANDIDATE_ARTIFACT", "Delivery requires a fixed Git Candidate; historical patch-only delivery is unsupported");
        if (!validDeliveryReceipt(receipt) || receipt.database_id !== this.databaseID) throw new Error("invalid preparation receipt or database");
        if (receipt.source_commit && (!source || source.commit !== receipt.source_commit || inspectCandidateSource(this.source, receipt.candidate_id, source).status !== "present")) throw new Error("fixed source retention ref missing or inconsistent; recover source explicitly before delivery");
        git(this.source, "check-ref-format", "--branch", branch);
        const existing = this.record(target);
        const local = this.local(target);
        if (existing && (existing.branch !== branch || !equal(existing.receipt, receipt))) throw new Error("request differs from the fixed preparation; use a new path");
        if (local.receipt && (!equal(local.receipt, receipt) || local.branch !== branch)) throw new Error("existing delivery differs from this request; use a new path");
        if (!["not_found", "incomplete", "ready"].includes(local.status)) throw new Error(local.reason);
        const state: RecordState = existing ?? { format: "patchledger.local-delivery/v1", target_path: target, branch, receipt, stage: "planned" };
        if (local.status !== "ready") {
          if (!present(target)) {
            if (this.branchExists(branch) || this.registered(target)) throw new Error("branch or worktree registration already exists; inspect manually or choose a new path and branch");
            atomic(this.recordPath(target), state);
            mkdirSync(dirname(target), { recursive: true });
            git(this.source, "worktree", "add", "-b", branch, target, receipt.source_commit.split(":")[1]);
            state.stage = "created"; atomic(this.recordPath(target), state);
          }
          const artifact = captureCommittedArtifact(target, receipt.baseline_oid, receipt.source_commit!);
          if (receipt.source_commit && (artifact.result_tree_oid !== receipt.result_tree_oid || artifact.patch_digest !== receipt.patch_digest)) throw new Error("fixed source content differs from Candidate SQL archive");
          state.stage = "applied"; atomic(this.recordPath(target), state);
          const confirmed = captureCommittedArtifact(target, receipt.baseline_oid, receipt.source_commit);
          if (confirmed.result_tree_oid !== receipt.result_tree_oid || confirmed.patch_digest !== receipt.patch_digest) throw new Error("artifact changed during preparation");
          this.completeReceipt(target, receipt);
          state.stage = "complete"; atomic(this.recordPath(target), state);
        }
        return { result_type: "patchledger.result.selection-materialize/v1" as const, command: "selection.materialize" as const, receipt, receipt_path: this.receiptPath(target), target_path: target, branch, materialization_mode: "delivery" as const, selection_warnings: warnings };
      });
    } catch (e) {
      const error = e instanceof DomainError ? e : worktreeMismatch("", String((e as Error).message).slice(0, 4096));
      // Recovery context is additive and contains no shell-escaped command string.
      error.details.target_path = [...target].slice(0, 32768).join("");
      error.details.inspect_argv = ["selection", "inspect", "--path", String(error.details.target_path), "--cwd", this.source];
      throw error;
    }
  }
}
