import { repositoryDataRoot } from "./data-layout.js";
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensureGroundsExcluded } from "./grounds-exclude.js";
import { newUUIDv7, isUUIDv7 } from "./identity.js";
import { validation } from "./errors.js";

/**
 * Review sessions give every independent verifier a private directory that the
 * CLI names and returns, so verification material no longer lands wherever the
 * caller happened to choose. The directory layout is
 * `<data-root>/repositories/<repository-key>/reviews/<candidate_id>/<review_session_id>/`: the `worktree`
 * subdirectory holds the checkout and the material files are its siblings, so
 * writing material never changes the tree that is verified.
 *
 * The layout is a naming convention, not isolation: a verifier with a shell can
 * still read other paths its user can read.
 */
export type ReviewRole = "contract" | "quality";
export type ReviewPhase = "blind" | "reconcile";

export const WORKTREE_DIRECTORY = "worktree";

const realDirectory = (path: string, label: string): void => {
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw validation("review_session", `${label} must be a real directory`);
};

const materialName = (kind: "context" | "handoff", role: ReviewRole, phase?: ReviewPhase): string => (kind === "context" ? `context-${phase}-${role}.json` : `handoff-${role}.json`);

export class ReviewSessions {
  readonly root: string;

  constructor(readonly repositoryRoot: string) {
    this.root = join(repositoryDataRoot(repositoryRoot), "reviews");
  }

  /** Creates a fresh session directory for the Candidate; the worktree itself is created by Git inside it. */
  allocate(candidateID: string): { session_id: string; directory: string; worktree: string } {
    if (!isUUIDv7(candidateID)) throw validation("candidate", "must be a lowercase UUIDv7");
    ensureGroundsExcluded(this.repositoryRoot);
    const sessionID = newUUIDv7();
    const directory = join(this.root, candidateID, sessionID);
    for (const part of [repositoryDataRoot(this.repositoryRoot), this.root, join(this.root, candidateID)]) { realDirectory(part, part); mkdirSync(part, { recursive: true, mode: 0o700 }); }
    mkdirSync(directory, { mode: 0o700 });
    return { session_id: sessionID, directory, worktree: join(directory, WORKTREE_DIRECTORY) };
  }

  /** Removes a session directory that never received a worktree; used when materialization failed. */
  discard(directory: string): void {
    if (resolve(directory).startsWith(resolve(this.root) + "/")) rmSync(directory, { recursive: true, force: true });
  }

  /** Resolves an existing session of this Candidate; sessions are only created by `allocate`, never invented by callers. */
  directory(candidateID: string, sessionID: string): string {
    if (!isUUIDv7(candidateID)) throw validation("candidate", "must be a lowercase UUIDv7");
    if (!isUUIDv7(sessionID)) throw validation("review_session", "must be a lowercase UUIDv7");
    const directory = join(this.root, candidateID, sessionID);
    if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw validation("review_session", "does not exist for this Candidate; create it with candidate materialize --mode review");
    return directory;
  }

  contextPath(candidateID: string, sessionID: string, role: ReviewRole, phase: ReviewPhase): string {
    return join(this.directory(candidateID, sessionID), materialName("context", role, phase));
  }

  handoffPath(candidateID: string, sessionID: string, role: ReviewRole): string {
    return join(this.directory(candidateID, sessionID), materialName("handoff", role));
  }

  /** A named material file beside `worktree/`; used for non-context material such as the report skeleton.
   * `name` is a caller-chosen stem, validated so it cannot escape the session directory. */
  materialPath(candidateID: string, sessionID: string, name: string, role: ReviewRole): string {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw validation("material", "must be a lowercase slug");
    return join(this.directory(candidateID, sessionID), `${name}-${role}.json`);
  }
}

/**
 * Writes a material file atomically with owner-only permissions and returns its absolute path.
 * `atomicPrivateWrite` is not reused on purpose: it rejects any symbolic link in the path, which would
 * refuse `--out` targets below macOS' symlinked /tmp and /var.
 */
export const writeMaterial = (path: string, value: unknown): string => {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, target);
  return target;
};
