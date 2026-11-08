import { createHash } from "node:crypto";
import type { SQLClient } from "../../../sql-client.js";
import { isDigest } from "../../domain/index.js";
import { evidenceChunkBytes as chunkSize, StorageFailure, type EvidenceRepository, type EvidenceSource } from "../../ports/index.js";

const fingerprint = (bytes: Uint8Array) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const invalid = (reason: string) => new StorageFailure("integrity",reason);

export class SqlEvidence implements EvidenceRepository {
  constructor(private readonly client: SQLClient, private readonly writable: boolean) {}

  async describe(digest: string) {
    const row = await this.client.get("SELECT byte_length, chunk_count FROM work_evidence WHERE digest = ?", [digest]);
    if (!row) return undefined;
    const byteLength = Number(row.byte_length), chunkCount = Number(row.chunk_count);
    if (!isDigest(digest) || !Number.isSafeInteger(byteLength) || byteLength < 0 || chunkCount !== Math.ceil(byteLength/chunkSize)) throw invalid("invalid evidence manifest");
    return { digest, byteLength, chunkCount };
  }

  async chunk(digest: string, ordinal: number) {
    const row = await this.client.get("SELECT bytes, chunk_digest FROM work_evidence_chunks WHERE digest = ? AND ordinal = ?",[digest,ordinal]);
    if (!row) return undefined;
    if (!(row.bytes instanceof Uint8Array) || row.bytes.length > chunkSize || !row.bytes.length || fingerprint(row.bytes) !== row.chunk_digest) throw invalid("evidence chunk failed its digest check");
    return row.bytes;
  }

  async verify(digest: string) {
    const ref = await this.describe(digest);
    if (!ref) throw invalid("evidence manifest missing");
    const hash = createHash("sha256");
    // Read at most 2 MiB per page while checking every ordinal and chunk digest.
    for (let first=0;first<ref.chunkCount;first+=32) {
      const end=Math.min(first+32,ref.chunkCount);
      const rows=await this.client.all("SELECT ordinal, bytes, chunk_digest FROM work_evidence_chunks WHERE digest = ? AND ordinal >= ? AND ordinal < ? ORDER BY ordinal",[digest,first,end]);
      if (rows.length!==end-first) throw invalid("missing or incorrectly sized evidence chunk");
      for (const [offset,row] of rows.entries()) {
        const i=first+offset;
        const data=row.bytes;
        if (Number(row.ordinal)!==i || !(data instanceof Uint8Array) || data.length!==Math.min(chunkSize,ref.byteLength-i*chunkSize)) throw invalid("missing or incorrectly sized evidence chunk");
        if (fingerprint(data)!==row.chunk_digest) throw invalid("evidence chunk failed its digest check");
        hash.update(data);
      }
    }
    const count = await this.client.get("SELECT COUNT(*) AS total FROM work_evidence_chunks WHERE digest = ?",[digest]);
    if (Number(count?.total) !== ref.chunkCount || "sha256:" + hash.digest("hex") !== digest) throw invalid("evidence does not match its manifest");
  }

  async put(source: EvidenceSource) {
    if (!this.writable) throw new StorageFailure("read-only","a read unit cannot store evidence");
    if (!isDigest(source.digest) || !Number.isSafeInteger(source.byteLength) || source.byteLength < 0) throw new StorageFailure("invalid","invalid evidence source");
    const existing = await this.describe(source.digest);
    if (existing) {
      if (existing.byteLength !== source.byteLength) throw invalid("evidence size conflicts with its digest");
      await this.verify(source.digest);
      return existing;
    }
    const ref = { digest:source.digest,byteLength:source.byteLength,chunkCount:Math.ceil(source.byteLength/chunkSize) };
    await this.client.run("INSERT INTO work_evidence (digest, byte_length, chunk_count) VALUES (?, ?, ?)",[ref.digest,ref.byteLength,ref.chunkCount]);
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(chunkSize);
    let ordinal = 0, total = 0, used = 0;
    const flush = async () => {
      const data = buffer.subarray(0,used);
      await this.client.run("INSERT INTO work_evidence_chunks (digest, ordinal, chunk_digest, bytes) VALUES (?, ?, ?, ?)",[ref.digest,ordinal++,fingerprint(data),data]);
      used = 0;
    };
    for await (const bytes of source.open()) {
      total += bytes.byteLength;
      if (total > ref.byteLength) throw invalid("evidence source grew during capture");
      hash.update(bytes);
      for (let offset = 0; offset < bytes.length;) {
        const n = Math.min(chunkSize-used,bytes.length-offset);
        buffer.set(bytes.subarray(offset,offset+n),used); offset += n; used += n;
        if (used === chunkSize) await flush();
      }
    }
    if (used) await flush();
    if (total !== ref.byteLength || ordinal !== ref.chunkCount || "sha256:" + hash.digest("hex") !== ref.digest) throw invalid("evidence source changed during capture");
    return ref;
  }
}
