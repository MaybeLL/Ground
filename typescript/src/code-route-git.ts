import { constants, existsSync, lstatSync, readlinkSync, renameSync, unlinkSync, openSync, closeSync, writeFileSync, fsyncSync } from "node:fs";
import { dirname, join } from "node:path";
import { CodeWorkspaceRoutes, type CodeWorkspaceRoute } from "./code-workspace-route.js";
import { assertRoutePreparing, assertRoutePaused, routeExecutionPath, type PausedRouteBinding, routeGitPendingPath } from "./code-route-fence.js";
import { sha256 } from "./canonical-json.js";
import { atomicPrivateWrite, digestBytes, privateDirectory, safeRead } from "./runtime-files.js";
import { git } from "./env-git.js";
import { validateAttribution, type Attribution } from "./domain.js";
import { isUUIDv7 } from "./identity.js";
import { DomainError, validation } from "./errors.js";
import { unfinishedOperationPaths } from "./development-branch.js";
import type { RouteEngine } from "./code-route-execution.js";
import type { Store } from "./store-types.js";

interface FileInput { path: string; mode: "100644" | "100755" | "120000" | "0"; bytes: string }
export interface RouteGitSnapshot {
  route_id: string; generation: number; head: string; index_digest: string; index_bytes: string;
  files: FileInput[]; attributes: FileInput[];
  execution?: { execution_id: string; pause_id: string };
}
interface Request { operation_id: string; action: "stage" | "unstage" | "commit"; paths?: string[]; message?: string; author?: { name: string; email: string }; snapshot: RouteGitSnapshot; attribution: Attribution }
export interface RouteGitResult {
  operation_id: string; action: string; state: "completed"; head: string; index_digest: string; tree: string;
}
interface Journal {
  format: "grounds.route-git-operation/v1"; route_id: string; database_id: string; host_id: string;
  digest: string; request: Request; created_at: string; phase: "intent" | "prepared" | "completed" | "aborted";
  aborted_by?: Attribution;
  result?: RouteGitResult; next_index?: string;
}
const conflict = (message: string): never => { throw new DomainError("STATE_CONFLICT", message); };
function fields(value: object, allowed: string[]): void {
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)))
    throw validation("request", "unexpected fields in managed Git input");
}
function pathInput(path: string): void {
  if (typeof path !== "string" || path.length > 1024 || !path || /[\\\x00-\x1f\x7f:]/.test(path)
    || path.split("/").some(part => !part || part === "." || part === ".." || /^\.git$/i.test(part)))
    throw validation("path", "requires a relative file path without Git metadata or traversal");
}
function bytes(input: string): Buffer {
  if (typeof input !== "string" || input.length > 24 * 1024 * 1024) throw validation("content", "snapshot exceeds its size limit");
  const value = Buffer.from(input, "base64");
  if (value.toString("base64") !== input) throw validation("content", "requires canonical base64");
  return value;
}
function supportedIndex(route: CodeWorkspaceRoute): void {
  if (unfinishedOperationPaths(route.path).some(path => existsSync(path)))
    throw validation("index", "complete the existing Git operation before managed writes");
  if (git(["rev-parse", "--show-object-format"], { cwd: route.path }) !== "sha1")
    throw validation("repository", "managed writes currently require SHA-1 object storage");
  const flags = git(["ls-files", "-v", "-z"], { cwd: route.path }).split("\0").filter(Boolean);
  const entries = git(["ls-files", "--stage", "-z"], { cwd: route.path }).split("\0").filter(Boolean);
  const diff = (flag: string) => git(["diff", "--cached", "--raw", "-z", "--no-ext-diff", "--no-textconv", flag], { cwd: route.path });
  if (flags.some(entry => /^[a-zS]/.test(entry)) || entries.some(entry => !/^(100644|100755|120000) [a-f0-9]+ 0\t/.test(entry))
    || diff("--ita-visible-in-index") !== diff("--ita-invisible-in-index"))
    throw validation("index", "managed writes do not support hidden flags, intent-to-add, conflicts or gitlinks");
}
function readInput(root: string, path: string): FileInput {
  pathInput(path);
  let cursor = root;
  const parts = path.split("/");
  for (const component of parts.slice(0, -1)) {
    cursor = join(cursor, component);
    const info = lstatSync(cursor, { throwIfNoEntry: false });
    if (!info) return { path, mode: "0", bytes: "" };
    if (!info.isDirectory() || info.isSymbolicLink()) throw validation("path", "snapshot refuses symbolic or non-directory parents");
  }
  const file = join(root, path), info = lstatSync(file, { throwIfNoEntry: false });
  if (!info) return { path, mode: "0", bytes: "" };
  if (info.isSymbolicLink()) return { path, mode: "120000", bytes: readlinkSync(file, { encoding: "buffer" }).toString("base64") };
  if (!info.isFile()) throw validation("path", "snapshot requires explicit regular files, links or deletions");
  return { path, mode: info.mode & 0o111 ? "100755" : "100644", bytes: safeRead(file, 8 * 1024 * 1024).toString("base64") };
}

/** Host coordinator writes only with preparation ownership or an exact, proven pause window. */
export class CodeRouteGit {
  constructor(private readonly store: Store, private readonly routeId: string,
    private readonly paused?: { binding: PausedRouteBinding; engine: RouteEngine }) {
    if (paused) this.paused = { binding: structuredClone(paused.binding), engine: paused.engine };
  }
  private control(route: CodeWorkspaceRoute, id?: string) {
    return this.paused ? assertRoutePaused(route, this.paused.binding, id).control : assertRoutePreparing(route, id);
  }
  private executionBinding() {
    return this.paused ? { execution_id: this.paused.binding.execution_id, pause_id: this.paused.binding.pause_id } : undefined;
  }
  private assertSnapshotContext(snapshot: RouteGitSnapshot) {
    if (sha256(snapshot.execution ?? null) !== sha256(this.executionBinding() ?? null))
      conflict("Git snapshot belongs to another execution or pause window");
  }
  private async route() { return new CodeWorkspaceRoutes(this.store).show(this.routeId); }
  private directory(route: CodeWorkspaceRoute, id: string) {
    if (!isUUIDv7(id)) throw validation("operation_id", "requires UUIDv7");
    return join(dirname(routeGitPendingPath(route)), id);
  }
  private index(route: CodeWorkspaceRoute) {
    return git(["rev-parse", "--path-format=absolute", "--git-path", "index"], { cwd: route.path });
  }
  private locked<T>(route: CodeWorkspaceRoute, action: () => Promise<T>, id?: string): Promise<T> {
    if (!route.dev_run_id) conflict("Bind the route before managed Git preparation");
    return new CodeWorkspaceRoutes(this.store).capture(route.route_id, route.dev_run_id!, route.path, async () => {
      if (this.paused) {
        const { run } = assertRoutePaused(route, this.paused.binding, id);
        if (!this.paused.engine.assertPaused || await this.paused.engine.identity() !== run.engine_id)
          conflict("Cannot prove the paused Git executor");
        await this.paused.engine.assertPaused!(run);
      }
      return action();
    }, "target", id, this.paused?.binding);
  }
  async snapshot(paths: string[]): Promise<RouteGitSnapshot> {
    if (!Array.isArray(paths) || paths.length > 128 || new Set(paths).size !== paths.length) throw validation("paths", "requires at most 128 distinct file paths");
    const route = await this.route();
    return this.locked(route, async () => {
      const control = this.control(route);
      supportedIndex(route);
      let size = 0;
      const read = (path: string) => {
        const file = readInput(route.path, path);
        size += bytes(file.bytes).length;
        if (size > 16 * 1024 * 1024) throw validation("snapshot", "snapshot exceeds its size limit");
        return file;
      };
      const index = safeRead(this.index(route), 8 * 1024 * 1024);
      const attributes = new Set<string>();
      for (const path of paths) {
        pathInput(path);
        for (let parent = dirname(path); ; parent = dirname(parent)) {
          attributes.add(parent === "." ? ".gitattributes" : `${parent}/.gitattributes`);
          if (parent === ".") break;
        }
      }
      return { route_id: route.route_id, generation: control.generation,
        head: git(["rev-parse", "HEAD"], { cwd: route.path }), index_digest: digestBytes(index), index_bytes: index.toString("base64"),
        files: paths.map(read), attributes: [...attributes].sort().map(read),
        ...(this.paused ? { execution: this.executionBinding() } : {}) };
    });
  }
  async abort(input: { operation_id: string; attribution: Attribution; unapplied_request?: Request }): Promise<{ operation_id: string; state: "aborted" }> {
    validateAttribution(input.attribution);
    const unapplied = input.unapplied_request ? structuredClone(input.unapplied_request) : undefined;
    const route = await this.route(), file = join(this.directory(route, input.operation_id), "journal.json");
    return this.locked(route, async () => {
      // The controller may have recorded a call before apply rejected its input.
      // Absence of a journal alone is not proof: retain partial directories and
      // pending effects, and require the host-pinned snapshot to still match.
      if (!lstatSync(file, { throwIfNoEntry: false }) && unapplied) {
        const snapshot = unapplied.snapshot;
        this.assertSnapshotContext(snapshot);
        validateAttribution(unapplied.attribution);
        if (unapplied.operation_id !== input.operation_id || snapshot.route_id !== route.route_id
          || snapshot.generation !== this.control(route, input.operation_id).generation
          || lstatSync(dirname(file), { throwIfNoEntry: false }) || lstatSync(routeGitPendingPath(route), { throwIfNoEntry: false })
          || git(["rev-parse", "HEAD"], { cwd: route.path }) !== snapshot.head
          || digestBytes(safeRead(this.index(route))) !== snapshot.index_digest
          || digestBytes(bytes(snapshot.index_bytes)) !== snapshot.index_digest)
          conflict("Cannot prove an unrecorded Git request had no effects");
        const cancelled: Journal = { format: "grounds.route-git-operation/v1", route_id: route.route_id,
          database_id: route.database_id, host_id: route.host_id, digest: sha256(unapplied), request: unapplied,
          created_at: new Date().toISOString(), phase: "aborted", aborted_by: structuredClone(input.attribution) };
        atomicPrivateWrite(file, JSON.stringify(cancelled));
      }
      const journal = JSON.parse(safeRead(file).toString()) as Journal;
      if (journal.format !== "grounds.route-git-operation/v1" || journal.route_id !== route.route_id || journal.database_id !== route.database_id
        || journal.host_id !== route.host_id || journal.request.operation_id !== input.operation_id || sha256(journal.request) !== journal.digest)
        conflict("Managed Git journal identity changed");
      this.assertSnapshotContext(journal.request.snapshot);
      if (journal.phase !== "aborted") {
        if (!["intent", "prepared"].includes(journal.phase)
          || this.control(route, input.operation_id).generation !== journal.request.snapshot.generation
          || git(["rev-parse", "HEAD"], { cwd: route.path }) !== journal.request.snapshot.head
          || digestBytes(safeRead(this.index(route))) !== journal.request.snapshot.index_digest)
          conflict("Cannot abort a Git operation whose effects are applied or unknown");
        journal.phase = "aborted";
        journal.aborted_by = structuredClone(input.attribution);
        atomicPrivateWrite(file, JSON.stringify(journal));
      }
      if (existsSync(routeGitPendingPath(route))) unlinkSync(routeGitPendingPath(route));
      return { operation_id: input.operation_id, state: "aborted" };
    }, input.operation_id);
  }
  async apply(input: Request): Promise<RouteGitResult> {
    const request = structuredClone(input), route = await this.route();
    validateAttribution(request.attribution);
    this.assertSnapshotContext(request.snapshot);
    const directory = this.directory(route, request.operation_id), journalPath = join(directory, "journal.json");
    const digest = sha256(request);
    return this.locked(route, async () => {
      let journal: Journal;
      if (existsSync(journalPath)) {
        journal = JSON.parse(safeRead(journalPath).toString());
        if (journal.format !== "grounds.route-git-operation/v1" || journal.route_id !== route.route_id
          || journal.database_id !== route.database_id || journal.host_id !== route.host_id || journal.digest !== digest)
          conflict("Managed Git request identity or bytes changed");
        if (journal.phase === "aborted") conflict("Managed Git request was aborted; use a new request after a fresh snapshot");
        if (journal.phase === "completed") {
          if (existsSync(routeGitPendingPath(route))) unlinkSync(routeGitPendingPath(route));
          return journal.result!;
        }
      } else {
        supportedIndex(route);
        fields(request, ["operation_id", "action", "snapshot", "attribution", ...(request.action === "unstage" ? ["paths"] : request.action === "commit" ? ["message", "author"] : [])]);
        const snapshot = request.snapshot;
        fields(snapshot, ["route_id", "generation", "head", "index_digest", "index_bytes", "files", "attributes", "execution"]);
        if (!["stage", "unstage", "commit"].includes(request.action) || !snapshot || snapshot.route_id !== route.route_id
          || !Array.isArray(snapshot.files) || (request.action === "stage" ? !snapshot.files.length : !!snapshot.files.length) || snapshot.files.length > 128
          || !Array.isArray(snapshot.attributes) || snapshot.attributes.length > 1024)
          throw validation("request", "requires a bounded route staging snapshot");
        if (request.action === "unstage") {
          if (!Array.isArray(request.paths) || !request.paths.length || request.paths.length > 128 || new Set(request.paths).size !== request.paths.length)
            throw validation("paths", "requires distinct paths to unstage");
          request.paths.forEach(pathInput);
        }
        if (request.action === "commit" && (typeof request.message !== "string" || !request.message.trim() || request.message.length > 65536 || request.message.includes("\0")
          || !request.author || [request.author.name, request.author.email].some(value => typeof value !== "string" || !value.trim() || value.length > 256 || /[<>\x00-\x1f\x7f]/.test(value))))
          throw validation("commit", "requires a bounded message and explicit author identity");
        if (request.author) fields(request.author, ["name", "email"]);
        if (bytes(snapshot.index_bytes).length > 8 * 1024 * 1024) throw validation("index", "index snapshot exceeds its size limit");
        let size = 0;
        for (const list of [snapshot.files, snapshot.attributes]) {
          if (new Set(list.map(file => file.path)).size !== list.length) throw validation("snapshot", "duplicate paths");
          for (const file of list) {
            fields(file, ["path", "mode", "bytes"]);
            pathInput(file.path);
            if (!["0", "100644", "100755", "120000"].includes(file.mode)) throw validation("mode", "unsupported index mode");
            size += bytes(file.bytes).length;
            if (file.mode === "0" && file.bytes) throw validation("content", "deletions have no bytes");
          }
        }
        if (size > 16 * 1024 * 1024) throw validation("snapshot", "snapshot exceeds its size limit");
        if (snapshot.generation !== this.control(route).generation
          || snapshot.head !== git(["rev-parse", "HEAD"], { cwd: route.path })
          || snapshot.index_digest !== digestBytes(safeRead(this.index(route)))
          || snapshot.index_digest !== digestBytes(bytes(snapshot.index_bytes))) conflict("Route changed after the snapshot");
        journal = { format: "grounds.route-git-operation/v1", route_id: route.route_id,
          database_id: route.database_id, host_id: route.host_id, digest, request, created_at: new Date().toISOString(), phase: "intent" };
        atomicPrivateWrite(journalPath, JSON.stringify(journal));
      }
      supportedIndex(route);
      if (this.control(route, request.operation_id).generation !== request.snapshot.generation)
        conflict("Route execution generation changed after the snapshot");
      await this.store.write(async tx => {
        await tx.lockDevRun(route.dev_run_id!);
        if ((await tx.getDevRun(route.dev_run_id!)).state !== "open") conflict("Managed Git requires an open DevRun");
      });
      if (this.paused) {
        const { run } = assertRoutePaused(route, this.paused.binding, request.operation_id);
        run.git_view_dirty = true;
        atomicPrivateWrite(routeExecutionPath(route, run.execution_id), JSON.stringify(run));
      }
      atomicPrivateWrite(routeGitPendingPath(route), JSON.stringify({ operation_id: request.operation_id }));
      if (journal.phase === "intent") {
        const snapshot = request.snapshot;
        const admin = privateDirectory(join(directory, "git")), work = privateDirectory(join(directory, "files"));
        const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: route.path });
        privateDirectory(join(admin, "refs"));
        privateDirectory(join(admin, "objects"));
        atomicPrivateWrite(join(admin, "HEAD"), snapshot.head + "\n");
        atomicPrivateWrite(join(admin, "config"), "[core]\nrepositoryformatversion = 0\nbare = false\nautocrlf = false\neol = lf\n");
        atomicPrivateWrite(join(admin, "index"), bytes(snapshot.index_bytes));
        const options = { cwd: work, gitDir: admin, workTree: work, env: { GIT_OBJECT_DIRECTORY: join(common, "objects") } };
        for (const file of snapshot.attributes) {
          if (!/(^|\/)\.gitattributes$/.test(file.path) || !["0", "100644", "100755"].includes(file.mode)) throw validation("attributes", "requires regular attribute files");
          if (file.mode !== "0") atomicPrivateWrite(join(work, file.path), bytes(file.bytes));
        }
        const attrs = git(["check-attr", "-z", "--stdin", "filter", "working-tree-encoding"], { ...options, input: snapshot.files.map(f => f.path + "\0").join("") }).split("\0");
        for (let i = 0; i + 2 < attrs.length; i += 3) if (!["unspecified", "unset"].includes(attrs[i + 2]))
          throw validation("attributes", "external filters and working-tree-encoding are not supported");
        let entries = "";
        for (const file of snapshot.files) {
          const oid = file.mode === "0" ? "0".repeat(snapshot.head.length) : git(["hash-object", "-w", "--stdin",
            ...(file.mode === "120000" ? ["--no-filters"] : ["--path", file.path])], { ...options, input: bytes(file.bytes) });
          entries += `${file.mode} ${oid}\t${file.path}\0`;
        }
        if (request.action === "stage") git(["update-index", "-z", "--index-info"], { ...options, input: entries });
        else if (request.action === "unstage") git(["--literal-pathspecs", "restore", "--staged", "--source", snapshot.head, "--", ...request.paths!], options);
        const tree = git(["write-tree"], options), next = safeRead(join(admin, "index"));
        let head = snapshot.head;
        if (request.action === "commit") {
          if (tree === git(["rev-parse", `${head}^{tree}`], options)) throw validation("commit", "there are no staged changes");
          head = git(["commit-tree", tree, "-p", snapshot.head, "-F", "-"], { ...options, input: request.message!, env: { ...options.env,
            GIT_AUTHOR_NAME: request.author!.name, GIT_AUTHOR_EMAIL: request.author!.email, GIT_AUTHOR_DATE: journal.created_at,
            GIT_COMMITTER_NAME: request.author!.name, GIT_COMMITTER_EMAIL: request.author!.email, GIT_COMMITTER_DATE: journal.created_at } });
        }
        git(["update-ref", "--no-deref", `refs/grounds/route-git/${route.route_id}/${request.operation_id}`, request.action === "commit" ? head : tree], { gitDir: common });
        journal.result = { operation_id: request.operation_id, action: request.action, state: "completed",
          head, tree, index_digest: request.action === "commit" ? snapshot.index_digest : digestBytes(next) };
        journal.next_index = next.toString("base64");
        journal.phase = "prepared";
        atomicPrivateWrite(journalPath, JSON.stringify(journal));
      }
      const indexPath = this.index(route), current = digestBytes(safeRead(indexPath));
      const head = git(["rev-parse", "HEAD"], { cwd: route.path });
      if (request.action === "commit") {
        if (current !== request.snapshot.index_digest) conflict("Route index changed during managed commit");
        if (head !== journal.result!.head) {
          if (head !== request.snapshot.head) conflict("Route HEAD changed during managed commit");
          git(["update-ref", "--no-deref", `refs/heads/${route.development.branch}`, journal.result!.head, request.snapshot.head], { cwd: route.path });
        }
      } else {
        if (head !== request.snapshot.head) conflict("Route HEAD changed during managed staging");
        if (current !== journal.result!.index_digest) {
          if (current !== request.snapshot.index_digest) conflict("Route index changed during managed staging");
          const lock = indexPath + ".lock";
          const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { writeFileSync(fd, bytes(journal.next_index!)); fsyncSync(fd); } finally { closeSync(fd); }
          renameSync(lock, indexPath);
          const parent = openSync(dirname(indexPath), constants.O_RDONLY);
          try { fsyncSync(parent); } finally { closeSync(parent); }
        }
      }
      journal.phase = "completed";
      atomicPrivateWrite(journalPath, JSON.stringify(journal));
      unlinkSync(routeGitPendingPath(route));
      return journal.result!;
    }, request.operation_id);
  }
}
