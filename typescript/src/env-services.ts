import { existsSync } from "node:fs";
import { join } from "node:path";
import { docker, resourceArguments, inspectOwnedContainer, assertEnvironmentEngine, ownedContainerExists, stopOwnedContainer, removeOwnedContainer } from "./env-docker.js";
import { environmentStoreRoot, readRecord, writeRecord } from "./env-store.js";
import { validation, stateConflict } from "./errors.js";
import type { EnvironmentServiceDeclaration, EnvironmentRequirements } from "./env-definition.js";
export interface SharedService { name: string; kind: "mysql"|"postgres"; container_id: string; network_id: string; host: string; port: number; repository_id: string; environment: string }
export interface PreparedService { name: string; kind: "mysql"|"postgres"; ownership: "private"|"shared"; container_id: string; host: string; port: number; network_id: string; image?: string }
export const registerSharedService = (service: SharedService): void => {
  if (!service || typeof service!=="object" || Array.isArray(service) || Object.keys(service).some(key=>!["name","kind","container_id","network_id","host","port","repository_id","environment"].includes(key))) throw validation("service","unknown shared service registration field");
  for(const key of ["name","kind","container_id","network_id","host","repository_id","environment"] as const)if(typeof service[key]!=="string"||service[key].length===0||service[key].length>512||/[\x00-\x1f]/.test(service[key]))throw validation("service","registration fields must be bounded nonempty declaration strings");
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(service.name) || !service.repository_id || !service.environment || !["mysql","postgres"].includes(service.kind) || !/^[a-f0-9]{64}$/.test(service.container_id) || !/^[a-f0-9]{64}$/.test(service.network_id) || !/^[a-zA-Z0-9.-]+$/.test(service.host) || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535) throw validation("service", "invalid explicit shared development/test service registration");
  const file = join(environmentStoreRoot(), "shared-services.json");
  const entries = existsSync(file) ? readRecord<SharedService[]>(file) : [];
  writeRecord(file,[...entries.filter(s=>s.name!==service.name),service]);
};
export const createTaskNetwork = (environmentId: string): string => docker(["network","create","--label",`grounds.environment=${environmentId}`,`grounds-${environmentId}`]);
export const removeTaskNetwork = (id: string, environmentId: string): void => {
  assertEnvironmentEngine(environmentId);
  if (!docker(["network","ls","-q","--no-trunc","--filter",`id=${id}`]).split("\n").includes(id)) return;
  const network = JSON.parse(docker(["network","inspect",id]))[0];
  if (network.Id !== id || network.Labels?.["grounds.environment"] !== environmentId) throw stateConflict("environment",environmentId,"network ownership unknown");
  docker(["network","rm",id]);
};
export const prepareServices = async (input: { environmentId: string; networkId: string; declarations: EnvironmentServiceDeclaration[]; requirements: EnvironmentRequirements; repositoryId?: string; environment: string; checkpoint: (services: PreparedService[])=>void }): Promise<PreparedService[]> => {
  const services: PreparedService[] = [];
  for (const declaration of input.declarations) {
    if (declaration.shared) {
      const file = join(environmentStoreRoot(), "shared-services.json");
      const shared = (existsSync(file)?readRecord<SharedService[]>(file):[]).find(s=>s.name===declaration.shared && s.repository_id===input.repositoryId && s.environment===input.environment && s.kind===declaration.kind);
      if (!shared) throw validation("service", "shared resource is missing or not authorized for this repository/environment");
      const actual = JSON.parse(docker(["inspect",shared.container_id]))[0];
      if (!actual.State.Running || !Object.values(actual.NetworkSettings.Networks).some((n:any)=>n.NetworkID===shared.network_id)) throw validation("service","explicit shared service is unavailable");
      docker(["exec",shared.container_id,...(declaration.kind==="postgres"?["pg_isready","-U","postgres"]:["mysqladmin","ping","--silent"])]);
      services.push({ name:declaration.name,kind:declaration.kind,ownership:"shared",container_id:shared.container_id,network_id:shared.network_id,host:shared.host,port:shared.port });
      input.checkpoint(services);
      continue;
    }
    const tag = declaration.image ?? (declaration.kind === "postgres" ? "postgres:16-alpine" : "mysql:8.4");
    try { docker(["image","inspect",tag]); } catch { docker(["pull",tag],300_000); }
    const image = JSON.parse(docker(["image","inspect",tag]))[0].Id as string;
    const env = declaration.kind === "postgres" ? ["-e","POSTGRES_HOST_AUTH_METHOD=trust","-e","POSTGRES_DB=task"] : ["-e","MYSQL_ALLOW_EMPTY_PASSWORD=yes","-e","MYSQL_DATABASE=task"];
    const id = docker(["create","--label",`grounds.environment=${input.environmentId}`,"--network",input.networkId,"--network-alias",declaration.name,...resourceArguments(input.requirements),...env,image]);
    const service: PreparedService = {name:declaration.name,kind:declaration.kind,ownership:"private",container_id:id,network_id:input.networkId,host:declaration.name,port:declaration.kind==="postgres"?5432:3306,image};
    services.push(service); input.checkpoint(services);
    docker(["start",id]);
    let ready = false;
    for (let i=0;i<60;i++) {
      const state = inspectOwnedContainer(id,input.environmentId);
      if (!state.State.Running) break;
      try { docker(["exec",id,...(declaration.kind==="postgres"?["pg_isready","-U","postgres"]:["mysqladmin","ping","--silent"])]); ready=true;break; } catch {}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    if (!ready) throw validation("service", `private service ${declaration.name} did not become ready; resources retained for reconcile`);
  }
  return services;
};
export const releaseServices = (environmentId: string, services: PreparedService[], checkpoint: (remaining: PreparedService[])=>void): void => {
  let remaining = [...services];
  for (const service of services) {
    if (service.ownership === "private" && ownedContainerExists(service.container_id,environmentId)) { stopOwnedContainer(service.container_id,environmentId); removeOwnedContainer(service.container_id,environmentId); }
    remaining=remaining.filter(s=>s!==service);checkpoint(remaining);
  }
};
