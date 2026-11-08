import type {OutputSlot,TaskKind} from "./definitions.js";

export type ArtifactDeclaration = {slot:string;files:{path:string;source:string}[]};
export type ManagedDeclaration = {commit?:string;artifacts:ArtifactDeclaration[]};

const object = (value:unknown):value is Record<string,unknown>=>!!value && typeof value==="object" && !Array.isArray(value);
export function outputPath(value:unknown):value is string {
  return typeof value==="string" && !/[\uD800-\uDFFF]/u.test(value) && !value.includes("\\") && !/[\u0000-\u001f]/u.test(value) &&
    value.split("/").every(part=>part!=="" && part!=="." && part!==".." && new TextEncoder().encode(part).length<=255);
}

export function portableArtifactPaths(paths:readonly string[]) {
  const files=new Set<string>(), directories=new Set<string>(), spelling=new Map<string,string>();
  for (const path of paths) {
    if (!outputPath(path)) return false;
    const parts=path.split("/");
    for (let i=0;i<parts.length;i++) {
      const prefix=parts.slice(0,i+1).join("/"),key=prefix.normalize("NFC").toUpperCase().toLowerCase();
      if (files.has(key) || spelling.has(key) && spelling.get(key)!==prefix) return false;
      spelling.set(key,prefix);
      if (i<parts.length-1) directories.add(key);
      else {if (directories.has(key)) return false;files.add(key);}
    }
  }
  return true;
}

/** The provider explicitly selects every file in each output slot. Paths
 * are relative to its writable workspace and to the archived artifact. */
export function parseManagedDeclaration(message:string,kind:TaskKind,slots:readonly OutputSlot[]):ManagedDeclaration|undefined {
  let parsed:unknown;
  try {parsed=JSON.parse(message.trim());} catch {return;}
  if (!object(parsed)) return;
  const commit=object(parsed.candidate) ? parsed.candidate.commit : undefined;
  if (kind==="coding" && (typeof commit!=="string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))) return;
  if (kind==="working" && parsed.candidate!==undefined) return;
  const declared=parsed.artifacts ?? [];
  if (!Array.isArray(declared)) return;
  const artifacts:ArtifactDeclaration[] = [];
  const seen=new Set<string>();
  for (const value of declared) {
    if (!object(value) || typeof value.slot!=="string" || seen.has(value.slot) || !slots.some(slot=>slot.key===value.slot) ||
        !Array.isArray(value.files) || !value.files.length) return;
    const files:ArtifactDeclaration["files"]=[];
    for (const file of value.files) {
      if (!object(file) || !outputPath(file.path) || !outputPath(file.source ?? file.path)) return;
      const path=file.path;
      files.push({path,source:typeof file.source==="string" ? file.source : path});
    }
    if (!portableArtifactPaths(files.map(file=>file.path))) return;
    artifacts.push({slot:value.slot,files}); seen.add(value.slot);
  }
  if (slots.some(slot=>slot.required && !seen.has(slot.key)) || kind==="working" && !artifacts.length) return;
  return {...(typeof commit==="string" ? {commit} : {}),artifacts};
}
