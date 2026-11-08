// Archiving a delivered commit as a tag on the repository's remote, and checking
// it again later (D147): push the tag, read it back, and trust only what the
// remote shows now. A receipt is self-describing; a historical receipt is never
// taken as a fresh observation.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { DeliveryItem, ReceiptCheck } from "../../domain/index.js";
import type { ArchiveObservation, ArchiveProtection, CodeArchivePort, CodeFetchResult, DeliveryReceiptPort } from "../../ports/index.js";

const run = promisify(execFile);
const RECEIPT_PREFIX = "git-delivery:v1:";
const REF_NAMESPACE = "refs/tags/grounds/deliveries/";
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export interface GitDeliveryReceipt {
  readonly format: "grounds.git-delivery/v1";
  readonly remote: string;
  readonly ref: string;
  readonly commit: string;
  readonly tree: string;
  readonly parents: readonly string[];
  readonly protection?: ArchiveProtection;
}

const validProtection = (value: ArchiveProtection | undefined): boolean => value === undefined ||
  !!value && ["protected", "unprotected"].includes(value.level) && typeof value.evidence === "string" &&
    value.evidence.trim().length > 0 && value.evidence.length <= 256;

export const encodeReceipt = (receipt: GitDeliveryReceipt): string => `${RECEIPT_PREFIX}${Buffer.from(JSON.stringify(receipt)).toString("base64url")}`;
export function decodeReceipt(text: string): GitDeliveryReceipt | undefined {
  if (!text.startsWith(RECEIPT_PREFIX)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(text.slice(RECEIPT_PREFIX.length), "base64url").toString("utf8")) as GitDeliveryReceipt;
    const sound = value.format === "grounds.git-delivery/v1" && typeof value.remote === "string" && value.remote.length > 0 && typeof value.ref === "string" && value.ref.startsWith(REF_NAMESPACE)
      && validProtection(value.protection) && typeof value.commit === "string" && OID.test(value.commit) && typeof value.tree === "string" && OID.test(value.tree) && Array.isArray(value.parents) && value.parents.every(p => typeof p === "string" && OID.test(p));
    return sound ? value : undefined;
  } catch { return undefined; }
}
/** The delivery identity a receipt's reference names. */
export const deliveryIdOf = (receipt: GitDeliveryReceipt): string => receipt.ref.slice(REF_NAMESPACE.length);

export type ArchiveResult =
  | { readonly status: "confirmed"; readonly receipt: string; readonly commit: string }
  /** The reference exists and points at another commit: the identity is taken. */
  | { readonly status: "conflict"; readonly reason: string }
  /** The commit is not there to archive. */
  | { readonly status: "invalid"; readonly reason: string }
  /** The remote could not be read or written; nothing is known about the tag. */
  | { readonly status: "unavailable"; readonly reason: string };

type Observed = { readonly state: "present"; readonly commit: string } | { readonly state: "absent" } | { readonly state: "unreachable"; readonly reason: string };

export class GitTagArchive implements DeliveryReceiptPort, CodeArchivePort {
  constructor(private readonly options: { timeoutMs?: number } = {}) {}

  private git(cwd: string | undefined, args: string[]): Promise<string> {
    return run("git", args, { ...(cwd ? { cwd } : {}), timeout: this.options.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } }).then(r => r.stdout);
  }

  private inspectGit(cwd: string | undefined, args: string[]): Promise<string> {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", LC_ALL: "C" } as NodeJS.ProcessEnv;
    for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_QUARANTINE_PATH"]) delete env[key];
    return run("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", ...args], {
      ...(cwd ? { cwd } : {}), timeout: this.options.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024, env,
    }).then(r => r.stdout);
  }

  private async observe(remote: string, ref: string, cwd?: string, inspecting = false): Promise<Observed> {
    try {
      const args = ["ls-remote", "--refs", "--", remote, ref];
      const out = (await (inspecting ? this.inspectGit(cwd, args) : this.git(cwd, args))).trim();
      if (out === "") return { state: "absent" };
      const [commit, name] = out.split(/\s+/);
      return name === ref && OID.test(commit ?? "") ? { state: "present", commit: commit! } : { state: "unreachable", reason: "the remote answered with something unexpected" };
    } catch (error) { return { state: "unreachable", reason: (error as Error).message.split("\n")[0] ?? "the remote could not be read" }; }
  }

  async resolveCommit(repositoryPath: string, commitish: string): Promise<string | undefined> {
    try { return (await this.git(repositoryPath, ["rev-parse", "--verify", `${commitish}^{commit}`])).trim(); } catch { return undefined; }
  }

  private async matchesRecordedObject(repositoryPath: string, receipt: GitDeliveryReceipt): Promise<boolean> {
    try {
      const body = await this.inspectGit(repositoryPath, ["--no-replace-objects", "cat-file", "commit", receipt.commit]);
      const headers = body.split("\n\n", 1)[0]!.split("\n");
      const parents = headers.filter(line => line.startsWith("parent ")).map(line => line.slice(7));
      if (!headers.includes(`tree ${receipt.tree}`) || parents.join(" ") !== receipt.parents.join(" ")) return false;
      await this.inspectGit(repositoryPath, ["--no-replace-objects", "rev-list", "--quiet", "--objects", "--missing=error", "--max-count=1", receipt.commit, "--"]);
      return true;
    } catch { return false; }
  }

  async inspect(repositoryPath: string, item: { id: string; receipt: string }): Promise<ArchiveObservation> {
    const receipt = decodeReceipt(item.receipt);
    if (!receipt || deliveryIdOf(receipt) !== item.id) return { id: item.id, status: "unavailable", tag: "unknown", protection: { level: "unknown" } };
    const recorded = { id: item.id, recordedCommit: receipt.commit, protection: receipt.protection ?? { level: "unknown" as const } };
    const seen = await this.observe(receipt.remote, receipt.ref, repositoryPath, true);
    if (seen.state === "unreachable") return { ...recorded, status: null, tag: "unknown" };
    if (seen.state === "present" && seen.commit === receipt.commit) {
      return { ...recorded, status: "intact", tag: "unchanged", remoteCommit: seen.commit };
    }
    const changed = seen.state === "present" ? { tag: "moved" as const, remoteCommit: seen.commit } : { tag: "missing" as const };
    if (await this.matchesRecordedObject(repositoryPath, receipt)) return { ...recorded, ...changed, status: "ref-changed" };

    // Fetch into a temporary object store. An inspection never writes FETCH_HEAD,
    // refs or objects in the user's repository, even when the tag has moved.
    let scratch: string | undefined;
    try {
      scratch = await mkdtemp(join(tmpdir(), "grounds-archive-check-"));
      const url = (await this.inspectGit(repositoryPath, ["ls-remote", "--get-url", "--", receipt.remote])).trim();
      const remote = isAbsolute(url) || /^[a-z][a-z0-9+.-]*:|^[^/]+:/i.test(url) ? url : resolve(repositoryPath, url);
      await this.inspectGit(scratch, ["init", "--bare", "--quiet", "--template=", `--object-format=${receipt.commit.length === 64 ? "sha256" : "sha1"}`]);
      try { await this.inspectGit(scratch, ["fetch", "--quiet", "--no-tags", "--depth=1", "--", remote, receipt.commit]); }
      catch (error) {
        const message = (error as { stderr?: string }).stderr ?? "";
        const absent = /not our ref|couldn't find remote ref|unadvertised object|not a valid object/.test(message);
        return { ...recorded, ...changed, status: absent ? "unavailable" : null };
      }
      return { ...recorded, ...changed, status: await this.matchesRecordedObject(scratch, receipt) ? "ref-changed" : "unavailable" };
    } catch { return { ...recorded, ...changed, status: null }; }
    finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  }

  /** Bring the delivered commit into the repository so the next worker can start from it. The remote is asked now, and must show the commit the receipt names. */
  async fetch(input: { repositoryPath: string; receipt: string }): Promise<CodeFetchResult> {
    const receipt = decodeReceipt(input.receipt);
    if (!receipt) return { status: "missing", reason: "the receipt cannot be read" };
    const seen = await this.observe(receipt.remote, receipt.ref, input.repositoryPath);
    if (seen.state === "unreachable") return { status: "unavailable", reason: seen.reason };
    if (seen.state === "absent" || seen.commit !== receipt.commit) return { status: "missing", reason: "the remote no longer shows the delivered commit under its tag" };
    try { await this.git(input.repositoryPath, ["fetch", "--no-tags", "--quiet", "--", receipt.remote, receipt.ref]); }
    catch (error) { return { status: "unavailable", reason: (error as Error).message.split("\n")[0] ?? "the commit could not be fetched" }; }
    return await this.resolveCommit(input.repositoryPath, receipt.commit) === receipt.commit ? { status: "fetched", commit: receipt.commit } : { status: "unavailable", reason: "the fetched objects do not contain the delivered commit" };
  }

  /** Archive a commit of the repository at `repositoryPath` under the delivery identity. Repeating it for the same commit is harmless. */
  async archive(input: { repositoryPath: string; remote: string; deliveryId: string; commit: string; protection?: ArchiveProtection }): Promise<ArchiveResult> {
    if (!validProtection(input.protection)) return { status: "invalid", reason: "invalid archive protection evidence" };
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.deliveryId)) return { status: "invalid", reason: "the delivery identity is not usable in a reference name" };
    const ref = `${REF_NAMESPACE}${input.deliveryId}`;
    let commit: string, tree: string, parents: string[];
    try {
      commit = (await this.git(input.repositoryPath, ["rev-parse", "--verify", `${input.commit}^{commit}`])).trim();
      tree = (await this.git(input.repositoryPath, ["rev-parse", `${commit}^{tree}`])).trim();
      parents = (await this.git(input.repositoryPath, ["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/).slice(1);
    } catch { return { status: "invalid", reason: `${input.commit} is not a commit of ${input.repositoryPath}` }; }
    const receipt = encodeReceipt({ format: "grounds.git-delivery/v1", remote: input.remote, ref, commit, tree, parents, ...(input.protection ? { protection: input.protection } : {}) });
    if (receipt.length > 1024) return { status: "invalid", reason: "archive receipt exceeds the delivery manifest limit" };
    const before = await this.observe(input.remote, ref, input.repositoryPath);
    if (before.state === "unreachable") return { status: "unavailable", reason: before.reason };
    if (before.state === "present" && before.commit !== commit) return { status: "conflict", reason: `${ref} already points at ${before.commit}` };
    if (before.state === "absent") {
      // A plain push of a new tag: never forced, so an existing different tag wins any race.
      try { await this.git(input.repositoryPath, ["push", "--porcelain", "--", input.remote, `${commit}:${ref}`]); }
      catch { /* A lost answer is not a failed write: read it back before deciding. */ }
      const after = await this.observe(input.remote, ref, input.repositoryPath);
      if (after.state === "unreachable") return { status: "unavailable", reason: after.reason };
      if (after.state === "absent") return { status: "unavailable", reason: "the push was not confirmed by reading the tag back" };
      if (after.commit !== commit) return { status: "conflict", reason: `${ref} points at ${after.commit}` };
    }
    return { status: "confirmed", commit, receipt };
  }

  /** Ask the remote now. Every item must still be where its receipt says; a remote that cannot be asked proves nothing either way. */
  async check(items: readonly DeliveryItem[]): Promise<ReceiptCheck> {
    let unavailable = false;
    for (const item of items) {
      const receipt = decodeReceipt(item.receipt);
      if (!receipt || deliveryIdOf(receipt) !== item.id) return "rejected";
      const seen = await this.observe(receipt.remote, receipt.ref);
      if (seen.state === "unreachable") { unavailable = true; continue; }
      if (seen.state === "absent" || seen.commit !== receipt.commit) return "rejected";
    }
    return unavailable ? "unavailable" : "accepted";
  }
}
