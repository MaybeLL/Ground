import { historyGit } from "./git-history-read.js";
import { validation } from "./errors.js";
interface CommitIdentity { oid: string; parents: string[]; tree_oid: string }

const oid = (value: string): string => {
  const raw = value.replace(/^(sha1|sha256):/, "");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw)) throw validation("commit", "a full Git object ID is required");
  if (value.startsWith("sha1:") && raw.length !== 40 || value.startsWith("sha256:") && raw.length !== 64) {
    throw validation("commit", "Git object ID does not match its algorithm");
  }
  return raw;
};
const text = historyGit;
const qualified = (raw: string): string => `${raw.length === 64 ? "sha256" : "sha1"}:${raw}`;

export function readCommit(cwd: string, commit: string): CommitIdentity {
  // cat-file reads the object, unaffected by pretty-format/show settings.
  const commitOid = oid(commit);
  const headers = text(cwd, ["cat-file", "commit", commitOid]).split("\n\n", 1)[0]!.split("\n");
  const tree = headers.find(line => line.startsWith("tree "))?.slice(5);
  if (!tree) throw validation("commit", "commit has no tree");
  return { oid: qualified(commitOid), parents: headers.filter(line => line.startsWith("parent ")).map(line => qualified(line.slice(7))), tree_oid: qualified(tree) };
}
