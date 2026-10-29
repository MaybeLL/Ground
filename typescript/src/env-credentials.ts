import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { flockSync } from "fs-ext";
import { environmentStoreRoot, readRecord, writeRecord, instanceDirectories } from "./env-store.js";
import { atomicPrivateWrite, digestBytes, privateDirectory, safeRead, directoryRegistryRoot } from "./runtime-files.js";
import { stateConflict, validation } from "./errors.js";
import type { EnvironmentCredentialDeclaration } from "./env-definition.js";
export interface CredentialGrant { name: string; repository_id: string; environment: string; source_file: string; account: string; method: string; access: "model" | "context-read" | "repository-read"; writeback?: boolean; identity_fields?: string[] }
export interface CredentialBinding { name: string; path: string; grant: CredentialGrant; source_version: string; identity_digest: string; sync?: "unchanged" | "updated" | "conflict" | "failed" }
/** Host authentication callers hold this lock across occupancy check and logout.
 * Preparation publishes its occupancy under the same source locks. The returned
 * release is explicit so an async authentication operation cannot unlock early. */
export const acquireCredentialSourceLocks = (sourceFiles: string[]): (() => void) => {
  const sources = [...new Set(sourceFiles.map(file => realpathSync(file)))].sort();
  const descriptors: number[] = [];
  const release = (): void => { for (const fd of descriptors.splice(0).reverse()) closeSync(fd); };
  try {
    for (const source of sources) {
      const key = createHash("sha256").update(source).digest("hex");
      const fd = openSync(join(privateDirectory(join(directoryRegistryRoot(), "credential-locks")), key), "a", 0o600);
      descriptors.push(fd);
      try { flockSync(fd, "exnb"); }
      catch { throw stateConflict("credential", key, "credential source is in use by preparation, synchronization or authentication; explicitly retry"); }
    }
    return release;
  } catch (error) { release(); throw error; }
};
/** No await inside this short publication transaction. A logout can either see
 * the preparing instance, or finish first and make this source check fail. */
export const withCredentialPreparation = <T>(bindings: CredentialBinding[], publish: () => T): T => {
  const release = acquireCredentialSourceLocks(bindings.map(binding => binding.grant.source_file));
  try {
    for (const binding of bindings) {
      if (digestBytes(safeRead(binding.grant.source_file, 1024 * 1024)) !== binding.source_version) {
        throw validation("credential", "source changed during preparation; explicitly prepare again");
      }
    }
    return publish();
  } finally { release(); }
};
const grantsFile = (): string => join(environmentStoreRoot(), "credential-grants.json");
const checkGrant = (grant: CredentialGrant): void => {
  if (!grant || typeof grant!=="object" || Array.isArray(grant) || Object.keys(grant).some(key=>!["name","repository_id","environment","source_file","account","method","access","writeback","identity_fields"].includes(key))) throw validation("grant","unknown credential authorization field");
  for(const key of ["name","repository_id","environment","source_file","account","method","access"] as const)if(typeof grant[key]!=="string"||grant[key].length===0||grant[key].length>4096||/[\x00-\x1f]/.test(grant[key]))throw validation("grant","authorization fields must be bounded nonempty declaration strings");
  if(grant.writeback!==undefined&&typeof grant.writeback!=="boolean")throw validation("grant","writeback must be boolean");
  if(grant.identity_fields!==undefined&&(!Array.isArray(grant.identity_fields)||grant.identity_fields.length>16||grant.identity_fields.some(field=>typeof field!=="string"||!/^[a-zA-Z_][a-zA-Z0-9_.]{0,127}$/.test(field))))throw validation("grant","identity_fields must name bounded JSON fields");
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(grant.name) || !grant.repository_id || !grant.environment || !grant.account || !grant.method || !["model","context-read","repository-read"].includes(grant.access)) throw validation("grant", "requires a repository/environment/reference/account/method and permitted read or model access");
  if (grant.writeback && !grant.identity_fields?.length) throw validation("grant", "writeback requires JSON identity_fields to prevent account or authentication-method changes");
  if (grant.writeback && (!grant.identity_fields!.some(field=>/(^|\.)(account|account_id|email)$/.test(field)) || !grant.identity_fields!.some(field=>/(^|\.)(method|auth_mode)$/.test(field)))) throw validation("grant", "writeback must bind both the authorized account and authentication method");
  const source=safeRead(grant.source_file, 1024 * 1024);
  const identity=identityOf(source,grant.identity_fields);
  for(const [field,value] of Object.entries(identity)){
    if (/(^|\.)(account|account_id|email)$/.test(field) && value!==grant.account) throw validation("grant","source account does not match explicit authorization");
    if (/(^|\.)(method|auth_mode)$/.test(field) && value!==grant.method) throw validation("grant","source authentication method does not match explicit authorization");
  }
};
export const registerCredentialGrant = (grant: CredentialGrant): void => {
  checkGrant(grant);
  const grants = existsSync(grantsFile()) ? readRecord<CredentialGrant[]>(grantsFile()) : [];
  writeRecord(grantsFile(), [...grants.filter(g => !(g.name === grant.name && g.repository_id === grant.repository_id && g.environment === grant.environment)), { ...grant, source_file: realpathSync(grant.source_file) }]);
};
const identityOf = (bytes: Buffer, fields: string[] = []): Record<string,unknown> => {
  if (!fields.length) return {};
  let value: Record<string,unknown>;
  try { value = JSON.parse(bytes.toString()); } catch { throw validation("credential", "identity-bound source must contain JSON"); }
  return Object.fromEntries(fields.map(field => { const found = field.split(".").reduce<unknown>((part,key) => part && typeof part === "object" ? (part as Record<string,unknown>)[key] : undefined, value); if (found === undefined) throw validation("credential", "required identity field missing"); return [field, found]; }));
};
export const authorizeCredentials = (input: { declarations: EnvironmentCredentialDeclaration[]; environment: string; taskRepositoryId?: string; resolvedRepositoryId?: string }): CredentialBinding[] => {
  if (!input.declarations.length) return [];
  if (!input.taskRepositoryId || input.taskRepositoryId !== input.resolvedRepositoryId) throw validation("repository", "credential injection requires an unambiguous existing repository resolution matching the task");
  const grants = existsSync(grantsFile()) ? readRecord<CredentialGrant[]>(grantsFile()) : [];
  return input.declarations.map(declaration => {
    const grant = grants.find(g=>g.name===declaration.name && g.repository_id===input.taskRepositoryId && g.environment===input.environment);
    if (!grant) throw validation("credential", `no host authorization for ${declaration.name} in this repository/environment`);
    checkGrant(grant);
    const bytes = safeRead(grant.source_file, 1024 * 1024);
    const path = declaration.path ?? declaration.name;
    if (path === "." || path.startsWith("/") || path.split("/").some(p=>!p || p === ".." || p === ".")) throw validation("credential.path", "requires a private relative file path");
    return { name: declaration.name, path, grant, source_version: digestBytes(bytes), identity_digest: digestBytes(Buffer.from(JSON.stringify(identityOf(bytes, grant.identity_fields)))) };
  });
};
export const injectCredentials = (directory: string, bindings: CredentialBinding[]): void => {
  privateDirectory(directory);
  for (const binding of bindings) {
    const bytes = safeRead(binding.grant.source_file, 1024 * 1024);
    if (digestBytes(bytes) !== binding.source_version) throw validation("credential", "source changed during preparation; explicitly prepare again");
    atomicPrivateWrite(join(directory,binding.path),bytes);
  }
  // Seed before the task can rotate its private copies or another instance can
  // replace the shared source. This file stays outside all task mounts.
  credentialRedactions(directory, bindings);
};
/** No refresh protocol: the selected CLI may update its own private file. CAS is against the same authorized source. */
export const syncCredentials = (directory: string, bindings: CredentialBinding[]): CredentialBinding[] => bindings.map(binding => {
  if (!binding.grant.writeback) return { ...binding, sync: "unchanged" };
  let release: (() => void) | undefined;
  try {
    release = acquireCredentialSourceLocks([binding.grant.source_file]);
    const returned = safeRead(join(directory,binding.path),1024*1024);
    if (digestBytes(Buffer.from(JSON.stringify(identityOf(returned,binding.grant.identity_fields)))) !== binding.identity_digest) return { ...binding, sync: "failed" };
    if (digestBytes(returned) === binding.source_version) return { ...binding, sync: "unchanged" };
    if (digestBytes(safeRead(binding.grant.source_file,1024*1024)) !== binding.source_version) return { ...binding, sync: "conflict" };
    atomicPrivateWrite(binding.grant.source_file,returned);
    return { ...binding, sync: "updated", source_version: digestBytes(returned) };
  } catch { return { ...binding, sync: "failed" }; }
  finally { release?.(); }
});
/** Private redaction material is scoped to this instance and removed with its
 * private directory. It never enters runtime records, mounts or output artifacts. */
export const credentialRedactions = (directory: string, bindings: CredentialBinding[]): string[] => {
 const historyFile=join(dirname(directory),"credential-redactions.json");
 let prior:unknown=[];
 try{if(existsSync(historyFile))prior=JSON.parse(safeRead(historyFile,16*1024*1024).toString());}
 catch{throw validation("credential","private redaction history is unreadable; retain the instance");}
 if(!Array.isArray(prior)||prior.some(value=>typeof value!=="string"))throw validation("credential","private redaction history is invalid; retain the instance");
 const values=bindings.flatMap(binding=>[join(directory,binding.path),binding.grant.source_file].flatMap(path=> {
  try {
    const raw = safeRead(path,1024*1024).toString();
    const strings: string[] = [raw];
    const walk = (value: unknown): void => { if (typeof value === "string" && value.length >= 4) strings.push(value); else if (value && typeof value === "object") Object.values(value).forEach(walk); };
    try { walk(JSON.parse(raw)); } catch {}
    return strings;
  } catch { return []; }
 }));
 const combined=[...new Set<string>([...prior,...values])];
 if(combined.length!==prior.length&&existsSync(directory)){
  const encoded=JSON.stringify(combined);
  if(Buffer.byteLength(encoded)>16*1024*1024)throw validation("credential","private redaction history limit reached; retain the instance");
  atomicPrivateWrite(historyFile,encoded);
 }
 return combined;
};

/** Authentication/logout callers must treat every unfinished instance as occupied, including unknown termination and failed cleanup. */
export const credentialOccupancy = (input: { sourceFile?: string; name?: string } = {}): { environment_id: string; name: string; source_file: string; state: string }[] => {
  const source=input.sourceFile ? realpathSync(input.sourceFile) : undefined;
  return instanceDirectories().flatMap(directory=>{
    const path=join(directory,"environment.json");if(!existsSync(path))return [];
    const record=readRecord<{id:string;state:string;credentials?:CredentialBinding[]}>(path);
    if(record.state==="released")return [];
    return (record.credentials??[]).filter(binding=>(!source||binding.grant.source_file===source)&&(!input.name||binding.name===input.name)).map(binding=>({environment_id:record.id,name:binding.name,source_file:binding.grant.source_file,state:record.state}));
  });
};
