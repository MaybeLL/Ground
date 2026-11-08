import { DomainError, schemaDetails } from "../../../errors.js";
import type { SQLClient } from "../../../sql-client.js";

const reject = (table: string) => new DomainError("SCHEMA_INCOMPATIBLE","evidence storage name is already occupied or has an incompatible definition",false,schemaDetails(2,table));

/** An empty TRIGGERS view is meaningful only when the account can inspect
 * triggers on this table. SHOW GRANTS ... USING includes active role grants.
 * Accept a positive global, database or table grant; a partially revoked
 * global privilege alone cannot prove access. */
async function canInspectTriggers(client: SQLClient, table: string) {
  const quote = (id: string) => "\`" + id.replaceAll("\`","\`\`") + "\`";
  const db = String((await client.get("SELECT DATABASE() AS db"))?.db);
  const roles = await client.all("SELECT role_name AS role_id,role_host AS host_id FROM information_schema.enabled_roles");
  const using = roles.map(role=>quote(String(role.role_id))+"@"+quote(String(role.host_id))).join(",");
  const rows = await client.all("SHOW GRANTS FOR CURRENT_USER()" + (using ? " USING " + using : ""));
  const grants = rows.map(row=>String(Object.values(row)[0]));
  const globalRestricted = grants.some(line=>/^REVOKE (?:.*\bTRIGGER\b|ALL PRIVILEGES)/i.test(line));
  const scopes = new Set([quote(db)+".*",quote(db)+"."+quote(table)]);
  for (const line of grants) {
    const match = /^GRANT (.+?) ON (.+?) TO /i.exec(line);
    if (!match || !match[1]!.split(", ").some(p=>p==="TRIGGER" || p==="ALL PRIVILEGES")) continue;
    const scope = match[2]!;
    if (scopes.has(scope) || (scope === "*.*" && !globalRestricted)) return true;
  }
  return false;
}

/** Only MySQL can leave committed DDL behind an in-progress schema-1
 * marker. Accept precisely the empty tables created by the upgrade. */
async function verifyPartialMySQL(client: SQLClient, table: string) {
  const metadata = await client.get("SELECT engine AS engine_name,table_collation AS collation_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?",[table]);
  if (metadata?.engine_name !== "InnoDB" || metadata.collation_name !== "utf8mb4_bin") throw reject(table);
  const columns = await client.all("SELECT column_name AS name,column_type AS typ,is_nullable AS nullable,extra AS extra_flags,column_default AS default_value,collation_name AS coll FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? ORDER BY ordinal_position",[table]);
  const head = table === "work_evidence";
  const expected = head ? ["digest:varchar(71)","byte_length:bigint","chunk_count:int"] : ["digest:varchar(71)","ordinal:int","chunk_digest:varchar(71)","bytes:longblob"];
  if (columns.some(c=>c.nullable !== "NO" || c.extra_flags || c.default_value !== null || (c.typ === "varchar(71)" && c.coll !== "utf8mb4_bin")) || columns.map(c=>c.name+":"+c.typ).join("|") !== expected.join("|")) throw reject(table);
  const indexes = await client.all("SELECT index_name AS name,non_unique AS non_unique_flag,sub_part AS prefix_length,index_type AS typ,is_visible AS visible_flag FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=?",[table]);
  if (indexes.some(i=>i.name !== "PRIMARY" || Number(i.non_unique_flag) !== 0 || i.prefix_length !== null || i.typ !== "BTREE" || i.visible_flag !== "YES")) throw reject(table);
  if (!await canInspectTriggers(client,table)) throw new DomainError("SCHEMA_INCOMPATIBLE","cannot verify triggers on partially created evidence storage",false,schemaDetails(2,table));
  const trigger = await client.get("SELECT 1 AS present FROM information_schema.triggers WHERE trigger_schema=DATABASE() AND event_object_table=? LIMIT 1",[table]);
  if (trigger) throw reject(table);
  const partition = await client.get("SELECT 1 AS present FROM information_schema.partitions WHERE table_schema=DATABASE() AND table_name=? AND partition_name IS NOT NULL LIMIT 1",[table]);
  if (partition) throw reject(table);
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
