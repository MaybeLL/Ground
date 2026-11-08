import { runGit as git } from "./git-command.js";
import { baselineUnavailable } from "./errors.js";
import { isGitOID, qualifiedOID } from "./identity.js";

const gitText = (cwd: string, args: string[], indexPath?: string): string => git(cwd, args, indexPath).toString("utf8");

export const resolveBaseline = (worktreePath = ".", reference = "HEAD"): string => {
  try {
    const requested = reference || "HEAD"; const qualified = isGitOID(requested); const rawReference = qualified ? requested.slice(requested.indexOf(":") + 1) : requested;
    // One process answers both questions; Git's output order is not specified, so lines are told apart by content.
    const lines = gitText(worktreePath, ["rev-parse", "--verify", `${rawReference}^{commit}`, "--show-object-format"]).trim().split(/\r?\n/);
    const format = lines.find(line => line === "sha1" || line === "sha256"), oid = lines.find(line => line !== format);
    if (lines.length !== 2 || !format || !oid) throw new Error("unexpected rev-parse output");
    const result = qualifiedOID(format, oid); if (qualified && result !== requested) throw new Error("qualified Git OID uses a different object format"); return result;
  } catch {
    throw baselineUnavailable(`Git could not resolve ${reference || "HEAD"} to a commit`);
  }
};
