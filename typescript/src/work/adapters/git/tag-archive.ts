// Archiving a delivered commit as a tag on the repository's remote, and checking
// it again later (D147): push the tag, read it back, and trust only what the
// remote shows now. A receipt is self-describing; a historical receipt is never
// taken as a fresh observation.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeliveryItem, ReceiptCheck } from "../../domain/index.js";
import type { DeliveryReceiptPort } from "../../ports/index.js";

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
}

export const encodeReceipt = (receipt: GitDeliveryReceipt): string => `${RECEIPT_PREFIX}${Buffer.from(JSON.stringify(receipt)).toString("base64url")}`;
export function decodeReceipt(text: string): GitDeliveryReceipt | undefined {
  if (!text.startsWith(RECEIPT_PREFIX)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(text.slice(RECEIPT_PREFIX.length), "base64url").toString("utf8")) as GitDeliveryReceipt;
    const sound = value.format === "grounds.git-delivery/v1" && typeof value.remote === "string" && value.remote.length > 0 && typeof value.ref === "string" && value.ref.startsWith(REF_NAMESPACE)
      && OID.test(value.commit) && OID.test(value.tree) && Array.isArray(value.parents) && value.parents.every(p => OID.test(p));
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

export class GitTagArchive implements DeliveryReceiptPort {
  constructor(private readonly options: { timeoutMs?: number } = {}) {}

  private git(cwd: string | undefined, args: string[]): Promise<string> {
    return run("git", args, { ...(cwd ? { cwd } : {}), timeout: this.options.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } }).then(r => r.stdout);
  }

  private async observe(remote: string, ref: string, cwd?: string): Promise<Observed> {
    try {
      const out = (await this.git(cwd, ["ls-remote", "--refs", "--", remote, ref])).trim();
      if (out === "") return { state: "absent" };
      const [commit, name] = out.split(/\s+/);
      return name === ref && OID.test(commit ?? "") ? { state: "present", commit: commit! } : { state: "unreachable", reason: "the remote answered with something unexpected" };
    } catch (error) { return { state: "unreachable", reason: (error as Error).message.split("\n")[0] ?? "the remote could not be read" }; }
  }

  /** Archive a commit of the repository at `repositoryPath` under the delivery identity. Repeating it for the same commit is harmless. */
  async archive(input: { repositoryPath: string; remote: string; deliveryId: string; commit: string }): Promise<ArchiveResult> {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.deliveryId)) return { status: "invalid", reason: "the delivery identity is not usable in a reference name" };
    const ref = `${REF_NAMESPACE}${input.deliveryId}`;
    let commit: string, tree: string, parents: string[];
    try {
      commit = (await this.git(input.repositoryPath, ["rev-parse", "--verify", `${input.commit}^{commit}`])).trim();
      tree = (await this.git(input.repositoryPath, ["rev-parse", `${commit}^{tree}`])).trim();
      parents = (await this.git(input.repositoryPath, ["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/).slice(1);
    } catch { return { status: "invalid", reason: `${input.commit} is not a commit of ${input.repositoryPath}` }; }
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
    return { status: "confirmed", commit, receipt: encodeReceipt({ format: "grounds.git-delivery/v1", remote: input.remote, ref, commit, tree, parents }) };
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
