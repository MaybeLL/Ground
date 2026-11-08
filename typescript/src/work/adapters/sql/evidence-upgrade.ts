import { DomainError, schemaDetails } from "../../../errors.js";
import type { SQLClient } from "../../../sql-client.js";

const reject = (table: string) => new DomainError("SCHEMA_INCOMPATIBLE","evidence storage name is already occupied or has an incompatible definition",false,schemaDetails(2,table));

/** Only MySQL can leave committed DDL behind an in-progress schema-1
 * marker. Accept precisely the empty tables created by the upgrade. */
async function verifyPartialMySQL(client: SQLClient, table: string) {
  const metadata = await client.get("SELECT engine AS engine_name,table_collation AS collation_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?",[table]);
  if (metadata?.engine_name !== "InnoDB" || metadata.collation_name !== "utf8mb4_bin") throw reject(table);
  const columns = await client.all("SELECT column_name AS name,column_type AS typ,is_nullable AS nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position",[table]);
  const head = table === "work_evidence";
  const expected = head ? ["digest:varchar(71)","byte_length:bigint","chunk_count:int"] : ["digest:varchar(71)","ordinal:int","chunk_digest:varchar(71)","bytes:longblob"];
  if (columns.some(c=>c.nullable !== "NO") || columns.map(c=>c.name+":"+c.typ).join("|") !== expected.join("|")) throw reject(table);
  const keys = await client.all("SELECT column_name AS name FROM information_schema.key_column_usage WHERE constraint_schema=DATABASE() AND table_name=? AND constraint_name='PRIMARY' ORDER BY ordinal_position",[table]);
  if (keys.map(k=>k.name).join(",") !== (head ? "digest" : "digest,ordinal")) throw reject(table);
  const fks = await client.all("SELECT column_name AS name, referenced_table_schema=DATABASE() AS local_schema, referenced_table_name AS target, referenced_column_name AS col FROM information_schema.key_column_usage WHERE constraint_schema=DATABASE() AND table_name=? AND referenced_table_name IS NOT NULL",[table]);
  if (head ? fks.length !== 0 : fks.length !== 1 || Number(fks[0]!.local_schema) !== 1 || fks[0]!.name !== "digest" || fks[0]!.target !== "work_evidence" || fks[0]!.col !== "digest") throw reject(table);
  const checks = await client.all("SELECT c.check_clause AS clause,t.enforced AS enforced FROM information_schema.table_constraints t JOIN information_schema.check_constraints c ON t.constraint_schema=c.constraint_schema AND t.constraint_name=c.constraint_name WHERE t.constraint_schema=DATABASE() AND t.table_name=? AND t.constraint_type='CHECK'",[table]);
  const conditions = checks.map(c=>String(c.clause).replace(/[`\s()]/g,"")).sort();
  if (checks.some(c=>c.enforced !== "YES") || conditions.join(",") !== (head ? "byte_length>=0,chunk_count>=0" : "ordinal>=0")) throw reject(table);
  if (await client.get(`SELECT 1 AS nonempty FROM ${table} LIMIT 1`)) throw reject(table);
}

export async function planEvidenceUpgrade(client: SQLClient, resuming: boolean) {
  const missing = new Set<string>();
  for (const table of ["work_evidence","work_evidence_chunks"]) {
    const row = await client.get(client.dialect.tableExistsSql(table));
    if (!Number(row?.present)) { missing.add(table); continue; }
    if (!resuming || client.dialect.ddlIsTransactional) throw reject(table);
    await verifyPartialMySQL(client,table);
  }
  return missing;
}
