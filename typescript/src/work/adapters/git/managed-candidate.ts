import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { inspectionEnvironment } from "./inspection-environment.js";
import { GitTagArchive } from "./tag-archive.js";

const run=promisify(execFile);
const validOid=(text:string)=>/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text);

/** Treat the container's bundle as untrusted pack data. Host Git operates in
 * a new bare repository with operator-controlled config, never in the agent's
 * writable checkout. The exact claimed commit must descend from the run base. */
export async function archiveCandidateBundle(archive:GitTagArchive,input:{repository:string;remote:string;baseline:string;commit:string;bundle:string;id:string;allowPublish:boolean}) {
  if(!validOid(input.commit)||!validOid(input.baseline)) throw new Error("candidate and baseline must be full OIDs");
  const root=await mkdtemp(join(tmpdir(),"grounds-candidate-import-"));
  const git=async(args:string[]) => (await run("git",["-c","core.hooksPath=/dev/null","-c","protocol.ext.allow=never",...args],{cwd:root,env:inspectionEnvironment(),timeout:120_000,maxBuffer:1024*1024})).stdout.trim();
  try {
    await git(["init","--quiet","--bare","--template=","--object-format="+(input.commit.length===64?"sha256":"sha1")]);
    await git(["fetch","--no-tags","--",pathToFileURL(input.repository).href,input.baseline]);
    await git(["-c","fetch.fsckObjects=true","fetch","--no-tags","--",input.bundle,"refs/grounds/candidate"]);
    if(await git(["rev-parse","--verify","FETCH_HEAD^{commit}"])!==input.commit) return {status:"invalid" as const,reason:"bundle ref is not the declared commit"};
    try {await git(["merge-base","--is-ancestor",input.baseline,input.commit]);}
    catch {return {status:"invalid" as const,reason:"candidate is not based on this run's starting commit"};}
    await git(["fsck","--full","--no-dangling",input.commit]);
    const remote=await archive.archiveRemote(input.repository,input.remote);
    return await archive.archive({repositoryPath:root,commit:input.commit,remote,deliveryId:input.id,observeOnly:!input.allowPublish});
  } finally {await rm(root,{recursive:true,force:true});}
}
