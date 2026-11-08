// Archiving a delivered commit as a tag on the repository's remote, and checking
// it again later (D147): push the tag, read it back, and trust only what the
// remote shows now. A receipt is self-describing; a historical receipt is never
// taken as a fresh observation.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { DeliveryItem, ReceiptCheck } from "../../domain/index.js";
import type { ArchiveObservation, ArchiveProtection, RepairIdentity, RepairInput, CodeArchivePort, CodeFetchResult, DeliveryReceiptPort } from "../../ports/index.js";

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

function stableRemote(value: string): boolean {
  return isAbsolute(value) || /^(?:https?|ssh|git|file):\/\//i.test(value) || /^[^/\s:]+:[^:]/.test(value);
}

function inspectionEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_QUARANTINE_PATH"]) delete env[key];
  return env;
}

export class GitTagArchive implements DeliveryReceiptPort, CodeArchivePort {
  constructor(private readonly options: { timeoutMs?: number } = {}) {}

  private git(cwd: string | undefined, args: string[]): Promise<string> {
    return run("git", args, { ...(cwd ? { cwd } : {}), timeout: this.options.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } }).then(r => r.stdout);
  }

  private isolatedGit(cwd: string | undefined, args: string[]): Promise<string> {
    return run("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", ...args], {
      ...(cwd ? { cwd } : {}), timeout: this.options.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024, env: inspectionEnvironment(),
    }).then(r => r.stdout);
  }

  private async sameEndpoint(remote: string, cwd?: string): Promise<boolean> {
    return (await this.isolatedGit(cwd, ["ls-remote", "--get-url", "--", remote])).trim() === remote;
  }

  private async observe(remote: string, ref: string, cwd?: string, inspecting = false): Promise<Observed> {
    try {
      if (inspecting && !await this.sameEndpoint(remote, cwd)) return { state: "unreachable", reason: "the checkout redirects the recorded archive endpoint" };
      const args = ["ls-remote", "--refs", "--", remote, ref];
      const out = (await (inspecting ? this.isolatedGit(cwd, args) : this.git(cwd, args))).trim();
      if (out === "") return { state: "absent" };
      const [commit, name] = out.split(/\s+/);
      return name === ref && OID.test(commit ?? "") ? { state: "present", commit: commit! } : { state: "unreachable", reason: "the remote answered with something unexpected" };
    } catch (error) { return { state: "unreachable", reason: (error as Error).message.split("\n")[0] ?? "the remote could not be read" }; }
  }

  async resolveCommit(repositoryPath: string, commitish: string): Promise<string | undefined> {
    try { return (await this.git(repositoryPath, ["rev-parse", "--verify", `${commitish}^{commit}`])).trim(); } catch { return undefined; }
  }

  /** Read raw headers, including parents hidden by a shallow boundary. Drain a large message without buffering it. */
  private async commitFacts(cwd: string, oid: string): Promise<{ tree: string; parents: string[] }> {
    const child = spawn("git", ["cat-file", "commit", oid], { cwd, env: inspectionEnvironment(), stdio: ["ignore", "pipe", "ignore"], timeout: this.options.timeoutMs ?? 60_000 });
    const ended = new Promise<void>((ok, fail) => {
      child.once("error", fail);
      child.once("close", code => code === 0 ? ok() : fail(new Error("could not read commit headers")));
    });
    let headers = "", done = false;
    const consume = async () => {
      for await (const bytes of child.stdout) {
        if (done) continue;
        headers += bytes.toString("latin1");
        const end = headers.indexOf("\n\n");
        if (end >= 0) { headers = headers.slice(0, end); done = true; }
        if (headers.length > 1024 * 1024) { child.kill(); throw new Error("commit headers exceed inspection limit"); }
      }
    };
    await Promise.all([ended, consume()]);
    const lines = headers.split("\n");
    const tree = lines[0]?.slice(5);
    const parents = lines.filter(line => line.startsWith("parent ")).map(line => line.slice(7));
    if (!done || !lines[0]?.startsWith("tree ") || !tree || !OID.test(tree) || parents.some(p => !OID.test(p))) throw new Error("invalid commit headers");
    return { tree, parents };
  }

  private async archiveRemote(repositoryPath: string, remote: string): Promise<string> {
    const names = (await this.isolatedGit(repositoryPath, ["remote"])).trim().split("\n");
    const urls = names.includes(remote)
      ? (await this.isolatedGit(repositoryPath, ["remote", "get-url", "--push", "--all", remote])).trim().split("\n")
      : [(await this.isolatedGit(repositoryPath, ["ls-remote", "--get-url", "--", remote])).trim()];
    if (urls.length !== 1 || !urls[0]) throw new Error("one publication destination is required");
    const url = urls[0];
    if (/^https?:\/\//i.test(url) && (new URL(url).username || new URL(url).password)) throw new Error("use a credential helper for archive authentication");
    return stableRemote(url) ? url : resolve(repositoryPath, url);
  }

  /** An isolated shallow fetch plus fsck verifies the recorded commit and the contents of its entire tree. */
  private async retrieve(scratch: string, source: string, ref: string, receipt: GitDeliveryReceipt, fullHistory = false): Promise<"verified" | "refused" | "unknown"> {
    try {
      if (!await this.sameEndpoint(source, scratch)) return "unknown";
      await this.isolatedGit(scratch, ["-c", "fetch.fsckObjects=true", "fetch", "--quiet", "--no-tags", ...(fullHistory ? [] : ["--depth=1"]), "--", source, ref]);
    } catch (error) {
      const message = String((error as { stderr?: string }).stderr ?? "");
      return /not our ref|couldn't find remote ref|unadvertised object|not a valid object/i.test(message) ? "refused" : "unknown";
    }
    try {
      if ((await this.isolatedGit(scratch, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).trim() !== receipt.commit) return "unknown";
      const facts = await this.commitFacts(scratch, receipt.commit);
      if (facts.tree !== receipt.tree || facts.parents.join(" ") !== receipt.parents.join(" ")) return "unknown";
      await this.isolatedGit(scratch, ["fsck", "--full", "--no-dangling", "--no-reflogs", "--no-progress", receipt.commit]);
      return "verified";
    } catch { return "unknown"; }
  }

  /** Export only objects already present in the caller's cache. The temporary
   * repository owns the config, shallow boundary and every ref used by upload-pack. */
  private async retrieveLocal(repositoryPath: string, scratch: string, receipt: GitDeliveryReceipt, fullHistory = false): Promise<"verified" | "refused" | "unknown"> {
    let objects: string;
    try { objects = (await this.isolatedGit(repositoryPath, ["rev-parse", "--path-format=absolute", "--git-path", "objects"])).trimEnd(); }
    catch (error) { return String((error as { stderr?: string }).stderr).includes("not a git repository") ? "refused" : "unknown"; }
    if (!isAbsolute(objects) || /[\r\n]/.test(objects)) return "unknown";
    const cache = join(scratch, fullHistory ? "local-history" : "local-cache");
    await mkdir(cache);
    await this.isolatedGit(cache, ["init", "--bare", "--quiet", "--template=", `--object-format=${receipt.commit.length === 64 ? "sha256" : "sha1"}`]);
    await writeFile(join(cache, "objects/info/alternates"), objects + "\n");
    try { await this.isolatedGit(cache, ["cat-file", "-e", receipt.commit]); }
    catch (error) { return (error as { code?: number }).code === 1 ? "refused" : "unknown"; }
    if (!fullHistory) await writeFile(join(cache, "shallow"), receipt.commit + "\n");
    await this.isolatedGit(cache, ["update-ref", "refs/heads/recorded", receipt.commit]);
    return this.retrieve(scratch, pathToFileURL(cache).href, "refs/heads/recorded", receipt, fullHistory);
  }

  async inspect(repositoryPath: string, item: { id: string; receipt: string }): Promise<ArchiveObservation> {
    const receipt = decodeReceipt(item.receipt);
    if (!receipt || deliveryIdOf(receipt) !== item.id) return { id: item.id, status: "unavailable", tag: "unknown", protection: { level: "unknown" } };
    const recorded = { id: item.id, recordedCommit: receipt.commit, protection: receipt.protection ?? { level: "unknown" as const } };
    // An older receipt naming "origin" cannot identify which clone owned that configuration.
    if (!stableRemote(receipt.remote)) return { ...recorded, status: null, tag: "unknown" };
    const seen = await this.observe(receipt.remote, receipt.ref, repositoryPath, true);
    if (seen.state === "unreachable") return { ...recorded, status: null, tag: "unknown" };
    if (seen.state === "present" && seen.commit === receipt.commit) return { ...recorded, status: "intact", tag: "unchanged", remoteCommit: seen.commit };
    const changed = seen.state === "present" ? { tag: "moved" as const, remoteCommit: seen.commit } : { tag: "missing" as const };
    let scratch: string | undefined;
    try {
      scratch = await mkdtemp(join(tmpdir(), "grounds-archive-check-"));
      await this.isolatedGit(scratch, ["init", "--bare", "--quiet", "--template=", `--object-format=${receipt.commit.length === 64 ? "sha256" : "sha1"}`]);
      const localResult = await this.retrieveLocal(repositoryPath, scratch, receipt).catch(() => "unknown" as const);
      if (localResult === "verified") return { ...recorded, ...changed, status: "ref-changed" };
      const byOid = await this.retrieve(scratch, receipt.remote, receipt.commit, receipt);
      if (byOid === "verified") return { ...recorded, ...changed, status: "ref-changed" };
      if (byOid === "refused") {
        // Some servers disallow direct OID fetches. An advertised ref may still supply the object.
        if (!await this.sameEndpoint(receipt.remote, repositoryPath)) return { ...recorded, ...changed, status: null };
        const refs = (await this.isolatedGit(repositoryPath, ["ls-remote", "--refs", "--", receipt.remote])).trim();
        if (!refs && localResult !== "unknown") return { ...recorded, ...changed, status: "unavailable" };
        const match = refs.split("\n").map(line => line.split("\t")).find(([oid]) => oid === receipt.commit);
        if (match?.[1] && await this.retrieve(scratch, receipt.remote, match[1], receipt) === "verified") return { ...recorded, ...changed, status: "ref-changed" };
      }
      return { ...recorded, ...changed, status: null };
    } catch { return { ...recorded, ...changed, status: null }; }
    finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  }

  /** A repair publishes another tag. Its identity is derived from the saved intent;
   * a retry first asks the remote whether the earlier push already succeeded. */
  repair(input: RepairInput): Promise<ArchiveResult> { return this.repairTag(input, input); }
  inspectRepair(identity: RepairIdentity): Promise<ArchiveResult> { return this.repairTag(identity); }

  private async repairTag(input: RepairIdentity, publish?: RepairInput): Promise<ArchiveResult> {
    const original = decodeReceipt(input.originalReceipt);
    if (!original || deliveryIdOf(original) !== input.originalId || !stableRemote(original.remote)) return { status: "invalid", reason: "repair needs a frozen receipt with a stable destination" };
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.archiveId) || input.archiveId === input.originalId) return { status: "invalid", reason: "repair needs a new archive identity" };
    const { remote, commit, tree, parents } = original;
    const ref = REF_NAMESPACE + input.archiveId;
    const receipt = encodeReceipt({ format: original.format, remote, commit, tree, parents, ref });
    if (receipt.length > 1024) return { status: "invalid", reason: "repair receipt exceeds the manifest limit" };
    let scratch: string | undefined;
    try {
      scratch = await mkdtemp(join(tmpdir(), "grounds-archive-repair-"));
      await this.isolatedGit(scratch, ["init", "--bare", "--quiet", "--template=", `--object-format=${commit.length === 64 ? "sha256" : "sha1"}`]);
      await this.isolatedGit(scratch, ["remote", "add", "destination", remote]);
      // An explicit push URL overrides pushInsteadOf. Refuse any remaining rewrite.
      await this.isolatedGit(scratch, ["remote", "set-url", "--push", "destination", remote]);
      const pushURL = (await this.isolatedGit(scratch, ["remote", "get-url", "--push", "--all", "destination"])).trim();
      if (pushURL !== remote || !await this.sameEndpoint(remote, scratch)) return { status: "invalid", reason: "the configured Git endpoint redirects the frozen destination" };
      const before = await this.observe(remote, ref, scratch, true);
      if (before.state === "unreachable") return { status: "unavailable", reason: "cannot observe the repair destination" };
      if (before.state === "present") {
        if (before.commit !== commit) return { status: "conflict", reason: "another object occupies the repair tag" };
        if (await this.retrieve(scratch, remote, ref, original) !== "verified") return { status: "unavailable", reason: "the advertised repair tag does not supply the verified object" };
        return { status: "confirmed", receipt, commit };
      }
      if (!publish) return { status: "unavailable", reason: "the repair tag is absent; repeat the repair with its operation ID to publish it" };

      let verified = await this.retrieveLocal(publish.repositoryPath, scratch, original, true).catch(() => "unknown");
      for (const prior of [original, ...publish.earlierReceipts.map(decodeReceipt)]) {
        if (verified === "verified") break;
        if (prior && prior.remote === remote && prior.commit === commit) verified = await this.retrieve(scratch, remote, prior.ref, original, true);
      }
      if (verified !== "verified") verified = await this.retrieve(scratch, remote, commit, original, true);
      if (verified !== "verified") verified = await this.retrieveLocal(publish.repositoryPath, scratch, original).catch(() => "unknown");
      if (verified !== "verified") return { status: "unavailable", reason: "cannot recover and verify the recorded object for repair" };
      let failure = "the repair tag could not be confirmed";
      try { await this.isolatedGit(scratch, ["push", "--porcelain", "--", "destination", `${commit}:${ref}`]); }
      catch (error) {
        // Remote hooks may print credentials or arbitrary text. Return only recognized categories.
        const output = String((error as { stdout?: string }).stdout ?? "") + String((error as { stderr?: string }).stderr ?? "");
        if (/remote rejected|hook declined|protected tag/i.test(output)) failure = "the server rejected the repair tag";
        else if (/permission denied|authentication failed|access denied|returned error: 40[13]/i.test(output)) failure = "the server denied permission to publish the repair tag";
        else if (/timed out|connection|resolve host|network/i.test(output)) failure = "the network failed during repair publication";
        else failure = "Git push failed and the repair tag could not be confirmed";
      }
      const after = await this.observe(remote, ref, scratch, true);
      if (after.state !== "present") return { status: "unavailable", reason: failure };
      return after.commit === commit ? { status: "confirmed", receipt, commit } : { status: "conflict", reason: "the repair tag points to a different commit" };
    } finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
  }

  /** Bring the delivered commit into the repository so the next worker can start from it. The remote is asked now, and must show the commit the receipt names. */
  async fetch(input: { repositoryPath: string; receipt: string }): Promise<CodeFetchResult> {
    const receipt = decodeReceipt(input.receipt);
    if (!receipt) return { status: "missing", reason: "the receipt cannot be read" };
    const seen = await this.observe(receipt.remote, receipt.ref, input.repositoryPath, true);
    if (seen.state === "unreachable") return { status: "unavailable", reason: seen.reason };
    if (seen.state === "absent" || seen.commit !== receipt.commit) return { status: "missing", reason: "the remote no longer shows the delivered commit under its tag" };
    const fetchedRef = `refs/grounds/fetch/${randomUUID()}`;
    try {
      if (!await this.sameEndpoint(receipt.remote, input.repositoryPath)) return { status: "unavailable", reason: "the checkout redirects the recorded archive endpoint" };
      await this.isolatedGit(input.repositoryPath, ["fetch", "--no-write-fetch-head", "--no-tags", "--quiet", "--", receipt.remote, `${receipt.ref}:${fetchedRef}`]);
      const fetched = (await this.isolatedGit(input.repositoryPath, ["rev-parse", "--verify", `${fetchedRef}^{commit}`])).trim();
      return fetched === receipt.commit ? { status: "fetched", commit: fetched } : { status: "missing", reason: "the fetched tag no longer points to the delivered commit" };
    } catch { return { status: "unavailable", reason: "the archived tag could not be fetched" }; }
    finally { await this.isolatedGit(input.repositoryPath, ["update-ref", "-d", fetchedRef]); }
  }

  /** Archive a commit of the repository at `repositoryPath` under the delivery identity. Repeating it for the same commit is harmless. */
  async archive(input: { repositoryPath: string; remote: string; deliveryId: string; commit: string; previousReceipt?: string; protection?: ArchiveProtection }): Promise<ArchiveResult> {
    if (!validProtection(input.protection)) return { status: "invalid", reason: "invalid archive protection evidence" };
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.deliveryId)) return { status: "invalid", reason: "the delivery identity is not usable in a reference name" };
    const ref = `${REF_NAMESPACE}${input.deliveryId}`;
    let commit: string, tree: string, parents: string[], remote: string;
    try {
      commit = (await this.git(input.repositoryPath, ["rev-parse", "--verify", `${input.commit}^{commit}`])).trim();
      ({ tree, parents } = await this.commitFacts(input.repositoryPath, commit));
    } catch { return { status: "invalid", reason: `the commit and its headers could not be read in ${input.repositoryPath}` }; }
    try { remote = await this.archiveRemote(input.repositoryPath, input.remote); }
    catch { return { status: "invalid", reason: "archive requires one stable remote destination without embedded HTTPS credentials" }; }
    if (input.previousReceipt !== undefined) {
      const frozen = decodeReceipt(input.previousReceipt);
      const sameProtection = frozen?.protection?.level === input.protection?.level && frozen?.protection?.evidence === input.protection?.evidence;
      if (!frozen || deliveryIdOf(frozen) !== input.deliveryId || frozen.commit !== commit || (frozen.remote !== remote && frozen.remote !== input.remote) || !sameProtection) {
        return { status: "conflict", reason: "the original operation archived a different delivery" };
      }
      // Reuse the frozen bytes (including pre-upgrade shallow parents or relative
      // destinations). The submission ledger still compares the entire request.
      return { status: "confirmed", commit, receipt: input.previousReceipt };
    }
    const receipt = encodeReceipt({ format: "grounds.git-delivery/v1", remote, ref, commit, tree, parents, ...(input.protection ? { protection: input.protection } : {}) });
    if (receipt.length > 1024) return { status: "invalid", reason: "archive receipt exceeds the delivery manifest limit" };
    const before = await this.observe(remote, ref, input.repositoryPath);
    if (before.state === "unreachable") return { status: "unavailable", reason: before.reason };
    if (before.state === "present" && before.commit !== commit) return { status: "conflict", reason: `${ref} already points at ${before.commit}` };
    if (before.state === "absent") {
      // A plain push of a new tag: never forced, so an existing different tag wins any race.
      try { await this.git(input.repositoryPath, ["push", "--porcelain", "--", remote, `${commit}:${ref}`]); }
      catch { /* A lost answer is not a failed write: read it back before deciding. */ }
      const after = await this.observe(remote, ref, input.repositoryPath);
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
