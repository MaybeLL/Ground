import {existsSync} from "node:fs";
import {atomicPrivateWrite,safeRead} from "../../../runtime-files.js";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { inspectionEnvironment } from "./inspection-environment.js";
import { decodeReceipt,deliveryIdOf,GitTagArchive } from "./tag-archive.js";

const run=promisify(execFile);
const validOid=(text:string)=>/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text);

/** Treat the container's bundle as untrusted pack data. Host Git operates in
 * a new bare repository with operator-controlled config, never in the agent's
 * writable checkout. The exact claimed commit must descend from the run base. */
export async function archiveCandidateBundle(archive:GitTagArchive,input:{repository:string;remote:string;baseline:string;commit:string;bundle:string;publicationPath:string;id:string;allowPublish:boolean;parentReceipt?:string}) {
  if(!validOid(input.commit)||!validOid(input.baseline)) throw new Error("candidate and baseline must be full OIDs");
  const root=await mkdtemp(join(tmpdir(),"grounds-candidate-import-"));
  const git=async(args:string[]) => (await run("git",["-c","core.hooksPath=/dev/null","-c","protocol.ext.allow=never",...args],{cwd:root,env:inspectionEnvironment(),timeout:120_000,maxBuffer:1024*1024})).stdout.trim();
  try {
    await git(["init","--quiet","--bare","--template=","--object-format="+(input.commit.length===64?"sha256":"sha1")]);
    // Only host-verified bundle contents can create this receipt. If the host
    // lost the push reply, remote readback no longer needs the source checkout.
    let verifiedReceipt:string|undefined;
    if (existsSync(input.publicationPath)) {
      const saved=JSON.parse(safeRead(input.publicationPath,8192).toString());
      const receipt=typeof saved.receipt==="string" && decodeReceipt(saved.receipt);
      if (saved.baseline!==input.baseline || !receipt || receipt.commit!==input.commit || receipt.remote!==input.remote || deliveryIdOf(receipt)!==input.id)
        return {status:"unavailable" as const,reason:"frozen managed publication identity changed"};
      verifiedReceipt=saved.receipt;
      const seen=await archive.inspect(root,{id:input.id,receipt:saved.receipt});
      if (seen.tag==="unchanged" && seen.remoteCommit===input.commit) return {status:"confirmed" as const,receipt:saved.receipt as string,commit:input.commit};
      if (seen.tag==="moved") return {status:"conflict" as const,reason:"the reserved publication tag now points at another commit"};
      if (seen.tag!=="missing" || !input.allowPublish) return {status:"unavailable" as const,reason:"managed publication was not confirmed by the remote"};
    }
    try { await git(["fetch","--no-tags","--",pathToFileURL(input.repository).href,input.baseline]); }
    catch {
      if (!input.parentReceipt) return {status: "unavailable" as const, reason: "the pinned repository baseline is unavailable"};
      const fetched = await archive.fetch({repositoryPath: root, receipt: input.parentReceipt});
      if (fetched.status !== "fetched" || fetched.commit !== input.baseline) {
        return {status: "unavailable" as const, reason: "the parent delivery could not supply the pinned baseline"};
      }
    }
    try { await git(["-c","fetch.fsckObjects=true","fetch","--no-tags","--",input.bundle,"refs/grounds/candidate"]); }
    catch { return verifiedReceipt ? {status:"unavailable" as const,reason:"the previously verified export is unavailable"} : {status: "invalid" as const, reason: "the exported candidate bundle failed verification"}; }
    if(await git(["rev-parse","--verify","FETCH_HEAD^{commit}"])!==input.commit) return {status:"invalid" as const,reason:"bundle ref is not the declared commit"};
    try {await git(["merge-base","--is-ancestor",input.baseline,input.commit]);}
    catch {return {status:"invalid" as const,reason:"candidate is not based on this run's starting commit"};}
    try { await git(["fsck","--full","--no-dangling",input.commit]); }
    catch { return {status: "invalid" as const, reason: "candidate objects failed integrity verification"}; }
    const remote = input.remote;
    return await archive.archive({repositoryPath:root,commit:input.commit,remote,deliveryId:input.id,observeOnly:!input.allowPublish,frozenDestination:true,
      reservePublication:async receipt=>{
        if (verifiedReceipt) return receipt===verifiedReceipt;
        atomicPrivateWrite(input.publicationPath,JSON.stringify({baseline:input.baseline,receipt}));
        return true;
      }});
  } finally {await rm(root,{recursive:true,force:true});}
}
