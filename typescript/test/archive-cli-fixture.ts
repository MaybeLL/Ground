import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ArchiveProtectionEvidence } from "../src/candidate-git-archive.js";

/** Real Git wire protocol over a temporary SSH executable. Archive fetches use
 * isolated repositories, so repository-local URL rewrites cannot stand in for
 * transport. No network or production credentials are involved. */
export function archiveCLITransport(t: { after(f: () => void): void }, root: string, remote: string, repositoryId: string, canonicalRemote = "ssh://git@example.test/team/repo") {
  // Exercise real server enforcement: these test archive tags can only be created.
  writeFileSync(join(remote, "hooks", "update"), `#!/bin/sh
case "$1" in
  refs/tags/grounds/candidates/*|refs/tags/grounds/deliveries/*)
    case "$2" in *[!0]*) echo "archive tags are immutable" >&2; exit 1;; esac;;
esac
exit 0
`, { mode: 0o700 });
  const keys = ["PATH", "TEST_ARCHIVE_REMOTE", "TEST_ARCHIVE_SSH_LOG", "TEST_ARCHIVE_TRANSPORT_FAIL"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const bin = join(root, "archive-bin"), log = join(root, "ssh.log"); mkdirSync(bin);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const {appendFileSync} = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('-G')) process.exit(1);
if (process.env.TEST_ARCHIVE_SSH_LOG) appendFileSync(process.env.TEST_ARCHIVE_SSH_LOG, JSON.stringify(args)+'\\n');
if (process.env.TEST_ARCHIVE_TRANSPORT_FAIL === '1') { process.stderr.write('Connection refused\\n'); process.exit(255); }
const command = args[args.length-1] || '';
const mode = command.startsWith('git-upload-pack ') ? 'upload-pack' : command.startsWith('git-receive-pack ') ? 'receive-pack' : undefined;
if (!mode || !args.some(arg => arg === ${JSON.stringify(new URL(canonicalRemote).username + '@' + new URL(canonicalRemote).hostname)})) process.exit(255);
const result = spawnSync(${JSON.stringify(realGit)}, [mode, process.env.TEST_ARCHIVE_REMOTE], {stdio:'inherit'});
process.exit(result.status ?? 255);
`, { mode: 0o700 });
  process.env.PATH = bin + ":" + original.PATH;
  process.env.TEST_ARCHIVE_REMOTE = remote; process.env.TEST_ARCHIVE_SSH_LOG = log;
  delete process.env.TEST_ARCHIVE_TRANSPORT_FAIL;
  t.after(() => { for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; } });
  const source = join(root, "archive-deployment.json"); writeFileSync(source, JSON.stringify({ repository: canonicalRemote, create_only_archive_namespace: true, team_read: true }));
  function policy(namespace: ArchiveProtectionEvidence["ref_namespace"] = "refs/tags/grounds/candidates/") {
    const evidence: ArchiveProtectionEvidence = {
      format: "grounds.archive-protection/v1", repository_id: repositoryId, canonical_remote: canonicalRemote, ref_namespace: namespace,
      source: { kind: "verified-deployment-config", locator: pathToFileURL(source).href, revision: `sha256:${createHash("sha256").update(readFileSync(source)).digest("hex")}`, verified_by: "isolated-test-operator" },
      observed_at: new Date(Date.now() - 1000).toISOString(), valid_until: new Date(Date.now() + 3600_000).toISOString(), currently_applicable: true,
      archive_identity_can_create: true, ordinary_identity_cannot_update: true, ordinary_identity_cannot_delete: true, team_can_read_by_ref: true,
      repository_backup: "verified", database_backup: "verified",
    };
    const file = join(root, namespace.includes("deliveries") ? "delivery-archive-policy.json" : "candidate-archive-policy.json");
    writeFileSync(file, JSON.stringify(evidence)); return file;
  }
  return { policy, calls: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0, fail: (value: boolean) => { if (value) process.env.TEST_ARCHIVE_TRANSPORT_FAIL = "1"; else delete process.env.TEST_ARCHIVE_TRANSPORT_FAIL; } };
}
