import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat,open,readdir,readlink,realpath} from "node:fs/promises";
import {isAbsolute,join,relative} from "node:path";

export class UnsupportedGitTree extends Error {}

const algorithm = (oid:string)=>oid.length === 64 ? "sha256" : "sha1";
function objectHash(oid:string,type:string,size:number|bigint) {
  return createHash(algorithm(oid)).update(type+" "+size+"\0");
}
export function checkCommit(oid:string,bytes:Buffer) {
  const match = /^tree ([a-f0-9]+)\n/.exec(bytes.toString("ascii",0,71));
  if (objectHash(oid,"commit",bytes.length).update(bytes).digest("hex") !== oid || match?.[1]?.length !== oid.length) {
    throw new Error("material does not identify the declared Git commit");
  }
  return match[1];
}

export async function verifyTree(root:string,oid:string,dir=root,requireReadonly=true):Promise<Buffer> {
  const here = await lstat(dir);
  if (!here.isDirectory() || requireReadonly && here.mode & 0o222) throw new Error("material directory is missing or writable");
  const entries = [];
  for (const name of await readdir(dir)) {
    const path = join(dir,name), stat = await lstat(path);
    let mode:string, hash:Buffer;
    if (stat.isDirectory()) {
      mode="40000"; hash=await verifyTree(root,oid,path,requireReadonly);
    } else if (stat.isFile()) {
      if (requireReadonly && stat.mode & 0o222) throw new Error("material file is writable");
      mode=stat.mode & 0o111 ? "100755" : "100644";
      const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try {
        const info=await file.stat();
        if (!info.isFile()) throw new Error("material file was replaced");
        const blob=objectHash(oid,"blob",info.size);
        for await (const bytes of file.createReadStream({autoClose:false})) blob.update(bytes);
        hash=blob.digest();
      } finally {await file.close();}
    } else if (stat.isSymbolicLink()) {
      const target=await readlink(path,{encoding:"buffer"});
      let physical:string;
      try {physical=await realpath(path);}
      catch(error) {
        if (["ENOENT","ELOOP","ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new UnsupportedGitTree("delivery contains a dangling or cyclic symlink");
        throw error;
      }
      const resolved=relative(root,physical);
      if ((!requireReadonly && isAbsolute(target.toString())) || resolved===".." || resolved.startsWith("../") || isAbsolute(resolved)) throw new UnsupportedGitTree("material symlink points outside its repository");
      mode="120000"; hash=objectHash(oid,"blob",target.length).update(target).digest();
    } else throw new Error("unexpected material file type");
    entries.push({sort:Buffer.from(name+(stat.isDirectory()?"/":"")),data:Buffer.concat([Buffer.from(mode+" "+name+"\0"),hash])});
  }
  entries.sort((left,right)=>Buffer.compare(left.sort,right.sort));
  const tree=Buffer.concat(entries.map(entry=>entry.data));
  return objectHash(oid,"tree",tree.length).update(tree).digest();
}
