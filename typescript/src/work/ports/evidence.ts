export const evidenceChunkBytes = 64 * 1024;
export type EvidenceRef = { digest: string; byteLength: number; chunkCount: number };
/** A source can be opened again if a database transaction retries. */
export type EvidenceSource = { digest: string; byteLength: number; open(): AsyncIterable<Uint8Array> };
export interface EvidenceRepository {
  put(source: EvidenceSource): Promise<EvidenceRef>;
  describe(digest: string): Promise<EvidenceRef | undefined>;
  chunk(digest: string, ordinal: number): Promise<Uint8Array | undefined>;
  verify(digest: string): Promise<void>;
}
