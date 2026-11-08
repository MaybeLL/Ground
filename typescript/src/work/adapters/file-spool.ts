import {createHash} from "node:crypto";
import {closeSync,constants,createReadStream,fstatSync,openSync} from "node:fs";
import {mkdtemp,open,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {nativeBinding} from "../../native-binding.js";
import {outputPath} from "../domain/managed-delivery.js";
import {validation} from "../../errors.js";

export async function spool(path: string) {
  const handle = await open(path,"wx",0o600);
  const hash = createHash("sha256");
  let byteLength = 0;
  return {
    handle,
    async append(data: Buffer) {
      let offset = 0;
      while (offset < data.length) {
        const { bytesWritten } = await handle.write(data,offset,data.length-offset);
        if (!bytesWritten) throw new Error("evidence spool write made no progress");
        offset += bytesWritten;
      }
      hash.update(data); byteLength += data.length;
    },
    source() { return { digest:"sha256:"+hash.digest("hex"),byteLength,open:()=>createReadStream(path) }; },
  };
}

async function snapshot(fd:number) {
  const before=fstatSync(fd,{bigint:true});
  if (!before.isFile()) throw validation("file","artifact input must be a regular file");
  const root=await mkdtemp(join(tmpdir(),"grounds-artifact-"));
  const dispose=()=>rm(root,{recursive:true,force:true});
  try {
    const output=await spool(join(root,"content"));
    let total=0n;
    try {
      for await (const bytes of createReadStream("",{fd,autoClose:false})) {
        total+=BigInt(bytes.length);
        if (total>before.size) throw validation("file","artifact input grew during capture");
        await output.append(bytes);
      }
    } finally {await output.handle.close();}
    const after=fstatSync(fd,{bigint:true});
    if (total!==before.size || before.size!==after.size || before.mtimeNs!==after.mtimeNs || before.ctimeNs!==after.ctimeNs) throw validation("file","artifact input changed during capture");
    return {source:output.source(),dispose};
  } catch (error) {await dispose();throw error;}
}

export async function captureArtifactFile(path:string) {
  const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
  try {return await snapshot(file.fd);} finally {await file.close();}
}

export async function captureWorkspaceFile(root:string,path:string) {
  if (!outputPath(path)) throw validation("file","expected a workspace-relative file");
  const parts=path.split("/");
  let fd=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try {
    for (const [index,part] of parts.entries()) {
      const child=nativeBinding().openChild(fd,part,index<parts.length-1);
      closeSync(fd);
      fd=child;
    }
    return await snapshot(fd);
  } finally {closeSync(fd);}
}
