// Only these service settings are replayed in a task Sandbox. Grounds supplies
// project identity, labels, network and bind mounts at launch.
type Service = {
  image:string; command?:string|string[]; entrypoint?:string|string[];
  environment?:Record<string,string>; depends_on?:string[]; volumes?:string[];
};
export type ComposeEnvironment = {service:string;services:Record<string,Service>;volumes:string[]};
const object=(value:unknown):value is Record<string,unknown>=>!!value && typeof value==="object" && !Array.isArray(value);
const literal=(v:unknown):v is string=>typeof v==="string" && !v.includes("$") && !v.includes("\0");
const name=(v:unknown):v is string=>typeof v==="string" && /^[a-z0-9][a-z0-9_-]{0,62}$/.test(v) && !Object.hasOwn(Object.prototype,v);
export const imageDigestPattern=/^sha256:[a-f0-9]{64}$/;

export function checkComposeSettings(settings:Record<string,unknown>) {
  const allowed=["name","workspaceFolder","remoteUser","containerUser","remoteEnv","userEnvProbe","overrideCommand",
    "updateRemoteUserUID","customizations","forwardPorts","portsAttributes","otherPortsAttributes","shutdownAction",
    "onCreateCommand","updateContentCommand","postCreateCommand","postStartCommand","postAttachCommand","waitFor"];
  for (const key of Object.keys(settings)) {
    if (!allowed.includes(key)) throw Error("unsupported Compose devcontainer setting: "+key);
  }
}

export function composeEnvironment(service:unknown,services:unknown,frozen:boolean,volumes:unknown=[]):ComposeEnvironment {
  if (!name(service) || !object(services) || !Object.hasOwn(services,service) || Object.keys(services).length>32) throw Error("invalid Compose services or execution service");
  if (!Array.isArray(volumes) || !volumes.every(name) || new Set(volumes).size!==volumes.length) throw Error("invalid Compose named volumes");
  const result:Record<string,Service>=Object.create(null);
  for (const [key,spec] of Object.entries(services)) {
    if (!name(key) || !object(spec) || Object.keys(spec).some(k=>!["image","depends_on","command","entrypoint","environment","volumes"].includes(k))) throw Error("unsupported Compose service setting: "+key);
    if (typeof spec.image!=="string" || !(frozen ? imageDigestPattern : /^[a-z0-9][a-z0-9./:@_-]*$/).test(spec.image)) throw Error("invalid Compose image: "+key);
    const item:Service={image:spec.image};
    for (const field of ["command","entrypoint"] as const) {
      const v=spec[field];
      if (v===undefined) continue;
      if (!literal(v) && !(Array.isArray(v) && v.every(literal))) throw Error("expected literal Compose "+field);
      item[field]=v;
    }
    if (spec.environment!==undefined) {
      if (!object(spec.environment) || !Object.entries(spec.environment).every(([k,v])=>/^\w+$/.test(k) && literal(v))) throw Error("expected literal Compose environment values");
      item.environment=spec.environment as Record<string,string>;
    }
    if (spec.volumes!==undefined) {
      if (key===service || !Array.isArray(spec.volumes)) throw Error("only dependencies may mount named volumes");
      const targets=new Set<string>();
      for (const entry of spec.volumes) {
        const mount=typeof entry==="string" && /^([a-z0-9_-]+):(\/[a-zA-Z0-9_./-]+)(?::(ro|rw))?$/.exec(entry);
        if (!mount || !volumes.includes(mount[1]) || !mount[2]!.slice(1).split("/").every(v=>v && v!==".." && v!==".") || targets.has(mount[2]!)) throw Error("invalid Compose dependency volume");
        targets.add(mount[2]!);
      }
      item.volumes=spec.volumes;
    }
    if (spec.depends_on!==undefined) {
      if (!Array.isArray(spec.depends_on) || !spec.depends_on.every(v=>name(v) && Object.hasOwn(services,v))) throw Error("invalid Compose dependencies");
      item.depends_on=spec.depends_on;
    }
    result[key]=item;
  }
  const done=new Set<string>(),visiting=new Set<string>();
  function visit(key:string) {
    if (visiting.has(key)) throw Error("cyclic Compose dependencies");
    if (done.has(key)) return;
    visiting.add(key);
    for (const dep of result[key]!.depends_on ?? []) visit(dep);
    visiting.delete(key);
    done.add(key);
  }
  for (const key of Object.keys(result)) visit(key);
  return {service,services:result,volumes};
}
