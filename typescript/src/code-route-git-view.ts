import { linkSync, lstatSync, mkdirSync, readdirSync, existsSync, renameSync, openSync, closeSync, fsyncSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { git, gitTry } from "./env-git.js";
import { atomicPrivateWrite, privateDirectory } from "./runtime-files.js";
import { validation } from "./errors.js";
import type { RouteExecution } from "./code-route-execution.js";

export const routeGitViewRoot = (run: RouteExecution): string =>
  join(resolve(run.code_path, "../../../.."), "runtime", "route-git-views", run.execution_id);

/** Only immutable object files are shared. Configuration, hooks and control files are never copied. */
function pinObjects(source: string, destination: string): void {
  if (lstatSync(source).isSymbolicLink()) throw validation("objects", "symbolic object stores are not supported");
  privateDirectory(destination);
  for (const entry of readdirSync(source)) {
    if (entry === "info") {
      const info = join(source, entry);
      if (!lstatSync(info).isDirectory() || readdirSync(info).includes("alternates") || readdirSync(info).includes("http-alternates"))
        throw validation("objects", "external object stores are not supported");
      continue; // Commit graphs and other accelerators are not required by the read view.
    }
    if (entry !== "pack" && !/^[a-f0-9]{2}$/.test(entry)) throw validation("objects", "unexpected object directory");
    const directory = join(source, entry);
    if (!lstatSync(directory).isDirectory()) throw validation("objects", "expected a real object directory");
    privateDirectory(join(destination, entry));
    for (const file of readdirSync(directory)) {
      const path = join(directory, file);
      const permitted = entry === "pack" ? /^pack-[a-f0-9]{40}(?:[a-f0-9]{24})?\.(pack|idx|rev|bitmap)$/.test(file)
        : /^[a-f0-9]{38}(?:[a-f0-9]{24})?$/.test(file);
      if (!permitted || !lstatSync(path).isFile()) throw validation("objects", "unexpected or symbolic object file");
      linkSync(path, join(destination, entry, file));
    }
  }
}

/** Called while the route and repository locks are held, before any container create. */
export function prepareRouteGitView(run: RouteExecution): void {
  if (basename(run.code_path) !== run.route_id || basename(dirname(run.code_path)) !== "development")
    throw validation("route", "unexpected route directory");
  const root = routeGitViewRoot(run);
  privateDirectory(dirname(root));
  mkdirSync(root, { mode: 0o700 }); // Never replace a previous/partial execution view.
  prepareView(run.code_path, join(root, "route"), "/workspace", "/grounds-git/route");
  for (const baseline of run.baselines ?? []) {
    prepareView(baseline.path, join(root, "baselines", baseline.alias), `/baselines/${baseline.alias}`, `/grounds-git/baselines/${baseline.alias}`);
  }
}

/** The executor stays paused for the entire replacement. Partial refreshes can be rebuilt. */
export function refreshRouteGitView(run: RouteExecution): void {
  const root = routeGitViewRoot(run), version = randomUUID();
  const prepared = join(root, `refresh-${version}`), current = join(root, "route", "git");
  prepareView(run.code_path, prepared, "/workspace", "/grounds-git/route");
  // The parent view directory is mounted; replacing its child is visible after unpause.
  // Keep old object pins until a separate reclamation protocol exists.
  if (existsSync(current)) renameSync(current, join(root, `retired-${version}`));
  renameSync(join(prepared, "git"), current);
  for (const directory of [prepared, join(root, "route"), root]) {
    const fd = openSync(directory, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

function prepareView(codePath: string, directory: string, workTree: string, containerDirectory: string): void {
  const index = git(["ls-files", "--stage", "-z"], { cwd: codePath });
  if (index.split("\0").some(entry => entry.startsWith("160000 ")))
    throw validation("index", "submodules are not supported by the diagnostic Git view");
  const flags = git(["ls-files", "-v", "-z"], { cwd: codePath }).split("\0").filter(Boolean);
  if (flags.some(entry => /^[a-zS]/.test(entry)))
    throw validation("index", "assume-unchanged and skip-worktree are not supported by the diagnostic Git view");
  // Rebuilding an index must not turn intent-to-add into a staged empty blob.
  const staged = (visibility: string) => git(["diff", "--cached", "--raw", "-z", "--no-ext-diff", "--no-textconv", visibility], { cwd: codePath });
  if (staged("--ita-visible-in-index") !== staged("--ita-invisible-in-index"))
    throw validation("index", "intent-to-add is not supported by the diagnostic Git view");
  const view = privateDirectory(join(directory, "git"));
  const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: codePath });
  const algorithm = git(["rev-parse", "--show-object-format"], { cwd: codePath });
  if (!["sha1", "sha256"].includes(algorithm)) throw validation("repository", "unsupported object format");
  pinObjects(join(common, "objects"), join(view, "objects"));
  privateDirectory(join(view, "refs"));
  const refs = git(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/", "refs/remotes/", "refs/tags/"], { cwd: codePath });
  atomicPrivateWrite(join(view, "packed-refs"), refs ? refs + "\n" : "");
  const head = gitTry(["symbolic-ref", "-q", "HEAD"], { cwd: codePath });
  atomicPrivateWrite(join(view, "HEAD"), head ? `ref: ${head}\n` : git(["rev-parse", "HEAD"], { cwd: codePath }) + "\n");
  atomicPrivateWrite(join(view, "config"), `[core]\nrepositoryformatversion = ${algorithm === "sha256" ? 1 : 0}\nbare = false\nworktree = ${workTree}\nhooksPath = /dev/null\nfsmonitor = false\n${algorithm === "sha256" ? "[extensions]\nobjectFormat = sha256\n" : ""}`);
  git(["update-index", "-z", "--index-info"], { gitDir: view, workTree: codePath, input: index });
  atomicPrivateWrite(join(directory, "git-pointer"), `gitdir: ${containerDirectory}/git\n`);
}
