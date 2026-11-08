import {createHash} from "node:crypto";
import {constants,createReadStream} from "node:fs";
import {mkdtemp,open,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
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

export async function captureArtifactFile(path:string) {
  const root = await mkdtemp(join(tmpdir(),"grounds-artifact-"));
  const dispose = ()=>rm(root,{recursive:true,force:true});
  try {
    const input = await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
    try {
      const before = await input.stat({bigint:true});
      if (!before.isFile()) throw validation("file","artifact input must be a regular file");
      const output = await spool(join(root,"content"));
      try {
        for await (const bytes of input.createReadStream({autoClose:false})) await output.append(bytes);
      } finally { await output.handle.close(); }
      const after = await input.stat({bigint:true});
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw validation("file","artifact input changed during capture");
      return {source:output.source(),dispose};
    } finally {await input.close();}
  } catch (error) {await dispose();throw error;}
}
