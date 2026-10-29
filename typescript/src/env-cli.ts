import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { dockerCapabilities, hostCapabilities } from "./env-capabilities.js";
import { readEnvironmentDefinitions, selectEnvironmentDefinition } from "./env-definition.js";
import { environmentDown, environmentUp, listEnvironments, readEnvironment, reconcileEnvironment, handoffEnvironment } from "./env-environment.js";
import { cancelRun, readRun, startRun } from "./env-run.js";
import { validation } from "./errors.js";
import { existsSync as pathExists } from "node:fs";
import { credentialOccupancy, registerCredentialGrant } from "./env-credentials.js";
import { registerSharedService } from "./env-services.js";

export const ENVIRONMENT_RESULT = "grounds.result.environment/v1";

export interface EnvironmentArgs {
  positionals: string[];
  values: Record<string, string | boolean | string[]>;
}

const ALLOWED_OPTIONS = new Set(["cwd", "config", "json", "help", "workspace", "definition", "argv-file", "timeout-seconds", "tail-bytes", "input-commit", "branch", "material-scope", "fixed-inputs-file", "dev-run", "requires-network", "artifact", "target", "source-commit", "grant-file", "service-file"]);
const DEFAULT_TAIL_BYTES = 16 * 1024;
const MAX_TAIL_BYTES = 256 * 1024;
const MAX_ARGV_FILE_BYTES = 64 * 1024;

const text = (args: EnvironmentArgs, key: string): string | undefined => {
  const value = args.values[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw validation(`--${key}`, "may be given only once");
  if (typeof value !== "string") throw validation(`--${key}`, "requires a value");
  return value;
};

const requireUnknownFree = (args: EnvironmentArgs): void => {
  for (const key of Object.keys(args.values)) if (!ALLOWED_OPTIONS.has(key)) throw validation(`--${key}`, "unknown option");
};

const positionalId = (args: EnvironmentArgs, field: string): string => {
  const id = args.positionals[2];
  if (id === undefined || args.positionals.length !== 3) throw validation(field, "exactly one identifier is required");
  return id;
};

const readArgv = (file: string): string[] => {
  const info = statSync(file);
  if (!info.isFile() || info.size > MAX_ARGV_FILE_BYTES) throw validation("argv-file", "must be a regular file of at most 64 KiB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw validation("argv-file", "must contain a JSON array of strings");
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw validation("argv-file", "must contain a JSON array of strings");
  return parsed as string[];
};

const timeoutOf = (args: EnvironmentArgs): number | undefined => {
  const raw = text(args, "timeout-seconds");
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) throw validation("timeout-seconds", "must be a positive integer");
  return Number(raw) * 1000;
};

const tailOf = (args: EnvironmentArgs): number => {
  const raw = text(args, "tail-bytes");
  if (raw === undefined) return DEFAULT_TAIL_BYTES;
  if (!/^[1-9][0-9]{0,6}$/.test(raw) || Number(raw) > MAX_TAIL_BYTES) throw validation("tail-bytes", "must be an integer from 1 to 262144");
  return Number(raw);
};

const readTail = (file: string, bytes: number): string => {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
};

export interface EnvironmentCommandContext {
  resolveRepository?: (workspace: string, devRunId?: string) => Promise<{executionMode?: import("./development-mode.js").DevelopmentMode;taskRepositoryId:string;resolvedRepositoryId:string;devRunId?:string;inputCommit?:string;branch?:string}>;
}
const upCommand = async (args: EnvironmentArgs, cwd: string, context?: EnvironmentCommandContext) => {
  const workspace = resolve(cwd, text(args, "workspace") ?? ".");
  const definition = selectEnvironmentDefinition(readEnvironmentDefinitions(workspace), text(args, "definition"));
  const needsIdentity=!!text(args,"dev-run") || definition.credentials.length>0 || definition.services.some(s=>s.shared) || pathExists(join(workspace,"..","owner.json"));
  const identity = needsIdentity && context?.resolveRepository ? await context.resolveRepository(workspace,text(args,"dev-run")) : undefined;
  if (text(args,"dev-run") && !identity) throw validation("dev-run","requires coordinator admission and repository resolution");
  if (identity?.executionMode && (identity.executionMode === "container") !== (definition.backend === "docker")) throw validation("dev-run", "environment backend conflicts with the fixed DevRun mode; start a new DevRun to change modes");
  const scope=text(args,"material-scope");
  if(scope!==undefined && scope!=="development" && scope!=="blind")throw validation("material-scope","must be development or blind");
  const inputsFile=text(args,"fixed-inputs-file");
  const fixedInputs=inputsFile?JSON.parse(readFileSync(inputsFile,"utf8")):undefined;
  if(fixedInputs!==undefined&&(!Array.isArray(fixedInputs)||fixedInputs.length>64||fixedInputs.some(i=>typeof i.name!=="string"||typeof i.path!=="string")))throw validation("fixed-inputs-file","requires [{name,path}] fixed single-file inputs");
  if(identity?.inputCommit && text(args,"input-commit") && identity.inputCommit.replace(/^sha(?:1|256):/,"")!==text(args,"input-commit")!.replace(/^sha(?:1|256):/,""))throw validation("input-commit","must equal the coordinator-admitted input");
  if(identity?.branch && text(args,"branch") && identity.branch!==text(args,"branch"))throw validation("branch","must equal the admitted development branch");
  if(definition.backend==="host")process.stderr.write(JSON.stringify({event:"environment.trust",mode:"trusted_host",enforced_isolation:false,message:"可信本机执行：setup和任务可使用当前用户权限；不强制隔离文件、网络或资源。"})+"\n");
  const environment = await environmentUp({ definition, workspace, ...identity, inputCommit:identity?.inputCommit??text(args,"input-commit"),branch:identity?.branch??text(args,"branch"),materialScope:scope as "development"|"blind"|undefined,fixedInputs });
  return { result_type: ENVIRONMENT_RESULT, command: "env.up", environment };
};

const runCommand = async (args: EnvironmentArgs, context?: EnvironmentCommandContext) => {
  const environmentId = positionalId(args, "environment_id");
  const environment=readEnvironment(environmentId);
  if(environment.dev_run_id){
    if(!context?.resolveRepository)throw validation("dev-run","execution requires the coordinator to recheck admission");
    const identity=await context.resolveRepository(environment.original_workspace,environment.dev_run_id);
    if (identity.executionMode && (identity.executionMode === "container") !== (environment.backend === "docker")) throw validation("dev-run", "environment backend conflicts with the fixed DevRun mode");
    if(identity.devRunId!==environment.dev_run_id||identity.taskRepositoryId!==environment.repository_id||identity.resolvedRepositoryId!==environment.repository_id)throw validation("dev-run","execution admission identity does not match the prepared task");
  }
  const file = text(args, "argv-file");
  if (file === undefined) throw validation("argv-file", "is required; give a JSON array of strings");
  const rawArtifacts=args.values.artifact;
  const artifacts=rawArtifacts===undefined?undefined:Array.isArray(rawArtifacts)?rawArtifacts:typeof rawArtifacts==="string"?[rawArtifacts]:[];
  if(readEnvironment(environmentId).backend==="host")process.stderr.write(JSON.stringify({event:"environment.trust",mode:"trusted_host",enforced_isolation:false,message:"即将运行可信本机命令，无强制隔离。"})+"\n");
  const started = startRun({ environmentId, argv: readArgv(file), timeoutMs: timeoutOf(args), requiresNetwork:bool(args,"requires-network"),artifacts });
  return { result_type: ENVIRONMENT_RESULT, command: "env.run", run: await started.done };
};

const logsCommand = (args: EnvironmentArgs) => {
  const runId = positionalId(args, "run_id");
  const record = readRun(runId);
  const log = join(record.directory, "output.log");
  const output = existsSync(log) ? readTail(log, tailOf(args)) : "";
  return { result_type: ENVIRONMENT_RESULT, command: "env.logs", run_id: runId, state: record.state, output };
};

export const envHelp = (): string => [
 "grounds env", "",
 "统一环境：默认可信 macOS/Linux host，没有文件、网络或资源隔离；声明 setup 也使用本机权限。",
 "Docker 在独立普通 Git 仓库中执行完整任务，使用固定镜像、默认 CPU/内存/PIDs 上限；失败不回退 host。",
 "env up [--workspace DIR] [--definition NAME] [--dev-run ID] [--input-commit SHA] [--branch NAME]",
 "       [--material-scope development|blind] [--fixed-inputs-file JSON]",
 "env run ENVIRONMENT_ID --argv-file FILE [--timeout-seconds N] [--requires-network] [--artifact PATH]",
 "env cancel RUN_ID | env logs RUN_ID [--tail-bytes N]",
 "env list | env show ENVIRONMENT_ID | env reconcile ENVIRONMENT_ID",
 "env handoff ENVIRONMENT_ID --target DIR --source-commit SHA (仅固定Git对象，不推进宿主分支)",
 "env down ENVIRONMENT_ID (显式结束，确认停止/交接后回收私有资源；摘要、日志和已收集产物保留)",
 "env credential-grant --grant-file JSON | env credential-occupancy | env service-register --service-file JSON",
 "凭据需求不构成授权；共享服务须显式登记/授权，共享可写数据可能互相干扰。",
 "run命令退出不代表作者完成、独立验证结束或Candidate已归档。固定输入/inputs只读；显式产物来自/output。",
].join("\n");

/** Runs one `env` command. Environment commands never open the ledger: they manage local runtime state only. */
export const executeEnvironmentCommand = async (args: EnvironmentArgs, cwd: string, context?: EnvironmentCommandContext): Promise<unknown> => {
  requireUnknownFree(args);
  const action = args.positionals[1] ?? "";
  if (bool(args, "help") || action === "") return { result_type: "patchledger.result.help/v1", command: "help", usage: envHelp() };
  switch (action) {
    case "up":
      return upCommand(args, cwd, context);
    case "list":
      return { result_type: ENVIRONMENT_RESULT, command: "env.list", environments: listEnvironments() };
    case "down": {
      const environmentId = positionalId(args, "environment_id");
      environmentDown(environmentId);
      return { result_type: ENVIRONMENT_RESULT, command: "env.down", environment_id: environmentId, removed: true, environment: readEnvironment(environmentId) };
    }
    case "run":
      return runCommand(args,context);
    case "cancel": {
      const runId = positionalId(args, "run_id");
      return { result_type: ENVIRONMENT_RESULT, command: "env.cancel", run: cancelRun(runId) };
    }
    case "reconcile": {
      return {result_type:ENVIRONMENT_RESULT,command:"env.reconcile",environment:reconcileEnvironment(positionalId(args,"environment_id"))};
    }
    case "show": return {result_type:ENVIRONMENT_RESULT,command:"env.show",environment:readEnvironment(positionalId(args,"environment_id"))};
    case "handoff": {
      const target=text(args,"target"),sourceCommit=text(args,"source-commit");
      if(!target||!sourceCommit)throw validation("handoff","requires --target and --source-commit");
      return {result_type:ENVIRONMENT_RESULT,command:"env.handoff",environment:handoffEnvironment({environmentId:positionalId(args,"environment_id"),target,sourceCommit})};
    }
    case "credential-occupancy": return {result_type:ENVIRONMENT_RESULT,command:"env.credential-occupancy",occupancy:credentialOccupancy()};
    case "credential-grant": {
      const file=text(args,"grant-file");if(!file)throw validation("grant-file","required");registerCredentialGrant(JSON.parse(readFileSync(file,"utf8")));
      return {result_type:ENVIRONMENT_RESULT,command:"env.credential-grant",registered:true};
    }
    case "service-register": {
      const file=text(args,"service-file");if(!file)throw validation("service-file","required");registerSharedService(JSON.parse(readFileSync(file,"utf8")));
      return {result_type:ENVIRONMENT_RESULT,command:"env.service-register",registered:true};
    }
    case "logs":
      return logsCommand(args);
    default:
      throw validation("action", "unknown env action");
  }
};

const bool = (args: EnvironmentArgs, key: string): boolean => args.values[key] === true;
