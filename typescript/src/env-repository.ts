import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { git } from "./env-git.js";
import { validation } from "./errors.js";

/** Local authorization identity, shared by linked worktrees but not by separate clones.
 * The inode binds the directory incarnation: recreating a repository at the same
 * path does not inherit grants. This is not a remote identity or an OS sandbox. */
export interface EnvironmentRepository {
  git_common_dir: string;
  device: string;
  inode: string;
}
const identityAt = (path: string): EnvironmentRepository => {
  const canonical = realpathSync(path);
  const stat = statSync(canonical, { bigint: true });
  if (!stat.isDirectory()) throw validation("repository", "Git common directory must be a directory");
  return { git_common_dir: canonical, device: String(stat.dev), inode: String(stat.ino) };
};
export const resolveEnvironmentRepository = (workspace: string): EnvironmentRepository => {
  try {
    if (git(["rev-parse", "--is-inside-work-tree"], { cwd: workspace }) !== "true") throw new Error();
    return identityAt(resolve(workspace, git(["rev-parse", "--git-common-dir"], { cwd: workspace })));
  } catch { throw validation("repository", "requires a readable local Git working tree"); }
};
export const sameEnvironmentRepository = (left: EnvironmentRepository | undefined, right: EnvironmentRepository | undefined): boolean =>
  !!left && !!right && left.git_common_dir === right.git_common_dir && left.device === right.device && left.inode === right.inode;
export const validateEnvironmentRepository = (value: EnvironmentRepository): void => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "device,git_common_dir,inode"
    || typeof value.git_common_dir !== "string" || value.git_common_dir.length > 4096 || !isAbsolute(value.git_common_dir) || /[\x00-\x1f]/.test(value.git_common_dir)
    || !/^[0-9]+$/.test(value.device) || typeof value.device !== "string" || !/^[0-9]+$/.test(value.inode) || typeof value.inode !== "string") {
    throw validation("repository", "requires the explicit identity returned by env repository");
  }
  try {
    const common = resolve(value.git_common_dir, git(["rev-parse", "--git-common-dir"], { cwd: value.git_common_dir, gitDir: value.git_common_dir }));
    if (realpathSync(common) !== value.git_common_dir || !sameEnvironmentRepository(value, identityAt(common))) throw new Error();
  } catch { throw validation("repository", "local Git repository identity changed or is unavailable; authorize explicitly again"); }
};
