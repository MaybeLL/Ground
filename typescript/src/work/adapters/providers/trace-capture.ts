import {spool} from "../file-spool.js";
import { constants } from "node:fs";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapturedTrace, ProviderName, TraceCapturePort } from "../../ports/index.js";
import { evidenceChunkBytes } from "../../ports/index.js";
import { commandLineProviders } from "./command-line.js";

const maxRecord = 8 * 1024 * 1024;
/** Raw bytes are copied once to a private spool. All derived events refer to
 * the physical input line, including when an unknown or malformed record was
 * skipped. Database transaction retries reopen the same immutable spools. */
export class ProviderTraceCapture implements TraceCapturePort {
  async capture(provider: ProviderName, file: string): Promise<CapturedTrace> {
    const root = await mkdtemp(join(tmpdir(),"grounds-provider-trace-"));
    const handles: FileHandle[] = [];
    try {
      const raw = await spool(join(root,"raw")); handles.push(raw.handle);
      const events = await spool(join(root,"events")); handles.push(events.handle);
      const adapter = commandLineProviders[provider];
      let records = 0, convertedRecords = 0, eventCount = 0, length = 0;
      const omissions = {invalidUtf8:0,invalidJson:0,oversized:0,unknownRecords:0,unknownParts:0,unserializableParts:0};
      let fragments: Buffer[] = [];
      const add = (part: Buffer) => {
        length += part.length;
        if (length <= maxRecord) fragments.push(part); else fragments = [];
      };
      const finish = async () => {
        records++;
        if (length > maxRecord) omissions.oversized++;
        else {
          let text: string | undefined;
          try { text = new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(fragments,length)); } catch { omissions.invalidUtf8++; }
          let parsed;
          if (text !== undefined) {
            try { parsed = JSON.parse(text); } catch { omissions.invalidJson++; }
          }
          if (parsed !== undefined) {
            const decoded = adapter.decode(parsed);
            const before = eventCount;
            if (!decoded.events.length) omissions.unknownRecords++;
            omissions.unknownParts += decoded.unknownParts;
            for (const {part,event} of decoded.events) {
              let line;
              try { line = JSON.stringify({seq:eventCount + 1,sourceLine:records,part,event}); }
              catch { omissions.unserializableParts++; continue; }
              await events.append(Buffer.from(line+"\n"));
              eventCount++;
            }
            if (eventCount > before) convertedRecords++;
          }
        }
        fragments = []; length = 0;
      };
      const input = await open(file,constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const stat = await input.stat();
        if (!stat.isFile()) throw new Error("expected a regular provider transcript file");
        for await (const block of input.createReadStream({autoClose:false})) {
          const bytes = Buffer.from(block);
          await raw.append(bytes);
          let start = 0;
          for (let end = bytes.indexOf(10,start); end >= 0; end=bytes.indexOf(10,start)) {
            add(bytes.subarray(start,end)); await finish(); start=end+1;
          }
          if (start < bytes.length) add(bytes.subarray(start));
        }
        if (length) await finish();
      } finally { await input.close(); }
      const rawSource = raw.source(), eventSource = events.source();
      const ref = (s: typeof rawSource) => ({digest:s.digest,byteLength:s.byteLength,chunkCount:Math.ceil(s.byteLength/evidenceChunkBytes)});
      return { descriptor: {format:"grounds.provider-trace/v1",provider,raw:ref(rawSource),events:ref(eventSource),records,convertedRecords,eventCount,omissions},
        raw:rawSource,events:eventSource,dispose:()=>rm(root,{recursive:true,force:true}) };
    } catch (error) { await rm(root,{recursive:true,force:true}); throw error; }
    finally { await Promise.all(handles.map(h=>h.close())); }
  }
}
