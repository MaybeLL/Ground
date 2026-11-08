// An Engine exec identity is obtained before the process is started. It can
// later be inspected without starting another process or replaying its input.
import { request } from "node:http";
import { open } from "node:fs/promises";
import type { Duplex } from "node:stream";
import type { DevcontainerRuntime } from "./runtime.js";
import type { RuntimeLocation, RuntimeOwner } from "../../ports/index.js";

const engineId = /^[0-9a-f]{64}$/;
export type ProcessTarget = {owner: RuntimeOwner; location: RuntimeLocation; containerId: string};
export type ProcessCommand = {argv: readonly string[]; cwd: string; user?: string; environment?: readonly string[]};
export type ExecStatus = {running: boolean; exitCode: number | null};

async function json<T>(socketPath: string, method: string, path: string, body?: object): Promise<T> {
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((ok,fail) => {
    const req = request({socketPath,method,path,headers:data ? {"Content-Type":"application/json","Content-Length":data.length} : {}}, async response => {
      try {
        if (!response.statusCode || response.statusCode >= 300) throw new Error(`Docker Engine ${method} failed (HTTP ${response.statusCode})`);
        const chunks: Buffer[] = []; let size=0;
        for await (const chunk of response) {
          size+=chunk.length; if (size>4*1024*1024) throw new Error("unexpected Docker control response size");
          chunks.push(chunk);
        }
        ok(JSON.parse(Buffer.concat(chunks).toString()) as T);
      } catch (error) { response.destroy(); fail(error); }
    });
    req.on("error",fail);
    req.setTimeout(30_000,()=>req.destroy(new Error("Docker control request timed out")));
    req.end(data);
  });
}

async function attach(socketPath: string, path: string) {
  const body=Buffer.from(JSON.stringify({Detach:false,Tty:false}));
  return new Promise<{socket:Duplex;head:Buffer}>((ok,fail)=>{
    const req=request({socketPath,method:"POST",path,headers:{"Content-Type":"application/json","Content-Length":body.length,Connection:"Upgrade",Upgrade:"tcp"}});
    req.once("upgrade",(response,socket,head)=>{
      if (response.statusCode !== 101) { socket.destroy(); fail(new Error("Docker refused the execution stream")); return; }
      req.setTimeout(0);
      ok({socket,head});
    });
    req.once("response",res=>{res.resume(); fail(new Error("Docker did not upgrade the execution stream: "+res.statusCode));});
    req.on("error",fail);
    req.setTimeout(30_000,()=>req.destroy(new Error("Docker stream handshake timed out")));
    req.end(body);
  });
}

/** Docker's non-TTY exec stream uses an 8-byte header followed by stdout or
 * stderr bytes. A truncated header/payload cannot be treated as a complete log. */
export async function demultiplex(source: AsyncIterable<Uint8Array>, write: (stream: 1 | 2, data: Buffer)=>Promise<void>) {
  let header=Buffer.alloc(0), remaining=0, stream: 1 | 2=1;
  for await (const chunk of source) {
    let bytes=Buffer.from(chunk);
    while (bytes.length) {
      if (!remaining) {
        const n=Math.min(8-header.length,bytes.length);
        header=Buffer.concat([header,bytes.subarray(0,n)]); bytes=bytes.subarray(n);
        if (header.length<8) continue;
        const tag=header[0];
        if ((tag!==1 && tag!==2) || header[1] || header[2] || header[3]) throw new Error("invalid Docker exec frame");
        stream=tag; remaining=header.readUInt32BE(4); header=Buffer.alloc(0);
        if (!remaining) continue;
      }
      const n=Math.min(remaining,bytes.length);
      if (n) await write(stream,bytes.subarray(0,n));
      remaining-=n; bytes=bytes.subarray(n);
    }
  }
  if (remaining || header.length) throw new Error("incomplete Docker execution stream");
}

export class EngineProcess {
  constructor(private readonly runtime: DevcontainerRuntime) {}

  private async endpoint(target: ProcessTarget) {
    if (!engineId.test(target.containerId)) throw new Error("invalid recorded container ID");
    const location=await this.runtime.location();
    if (location.hostId!==target.location.hostId || location.daemonId!==target.location.daemonId) throw new Error("execution belongs to a different runtime location");
    const instance=await this.runtime.observe(target.owner);
    if (instance?.id!==target.containerId) throw new Error("execution container no longer matches the reservation");
    const socket=await this.runtime.localSocket();
    const info=await json<{ID:string}>(socket,"GET","/info");
    if (info.ID!==location.daemonId) throw new Error("engine socket does not match the frozen daemon");
    const {ApiVersion}=await json<{ApiVersion:string}>(socket,"GET","/version");
    if (!/^1\.\d+$/.test(ApiVersion)) throw new Error("invalid Docker Engine API version");
    return {socket,api:"/v"+ApiVersion};
  }

  async create(target: ProcessTarget, command: ProcessCommand) {
    const {socket,api}=await this.endpoint(target);
    const response=await json<{Id:string}>(socket,"POST",api+"/containers/"+target.containerId+"/exec",{
      AttachStdin:true,AttachStdout:true,AttachStderr:true,Tty:false,Cmd:command.argv,WorkingDir:command.cwd,
      ...(command.user ? {User:command.user} : {}),...(command.environment ? {Env:command.environment} : {}),
    });
    if (!engineId.test(response.Id)) throw new Error("Docker did not return an execution ID");
    return response.Id;
  }

  private async inspect(socket:string,api:string,target:ProcessTarget,id:string) {
    if (!engineId.test(id)) throw new Error("invalid Docker exec ID");
    const data=await json<{ID:string;ContainerID:string;Running:boolean;ExitCode:number}>(socket,"GET",api+"/exec/"+id+"/json");
    if (data.ID!==id || data.ContainerID!==target.containerId || typeof data.Running!=="boolean") throw new Error("Docker exec identity mismatch");
    return {running:data.Running,exitCode:!data.Running && Number.isInteger(data.ExitCode) ? data.ExitCode : null};
  }

  async observe(target:ProcessTarget,id:string):Promise<ExecStatus> {
    const {socket,api}=await this.endpoint(target);
    return this.inspect(socket,api,target,id);
  }

  async start(target:ProcessTarget,id:string,input:string,stdoutPath:string,stderrPath:string,streamLimit?:number) {
    const {socket,api}=await this.endpoint(target);
    const before=await this.inspect(socket,api,target,id);
    if (before.running) throw new Error("Docker exec is already running");
    const byteCounts = {stdout:0,stderr:0};
    const out=await open(stdoutPath,"wx",0o600);
    try {
      const err=await open(stderrPath,"wx",0o600);
      try {
        const connected=await attach(socket,api+"/exec/"+id+"/start");
        try {
          connected.socket.end(Buffer.from(input));
          async function* stream() { if (connected.head.length) yield connected.head; yield* connected.socket; }
          await demultiplex(stream(),async (tag,data)=>{
            const channel = tag === 1 ? "stdout" : "stderr";
            const before = byteCounts[channel];
            byteCounts[channel] += data.length;
            if (streamLimit !== undefined) data = data.subarray(0, Math.max(0,streamLimit - before));
            const dest=tag===1 ? out : err;
            for (let offset=0;offset<data.length;) {
              const {bytesWritten}=await dest.write(data,offset,data.length-offset);
              if (!bytesWritten) throw new Error("could not persist process output");
              offset+=bytesWritten;
            }
          });
          await Promise.all([out.sync(),err.sync()]);
        } finally {connected.socket.destroy();}
      } finally {await err.close();}
    } finally {await out.close();}
    const status = await this.inspect(socket,api,target,id);
    return {...status,...(streamLimit === undefined ? {} : {byteCounts})};
  }
}
