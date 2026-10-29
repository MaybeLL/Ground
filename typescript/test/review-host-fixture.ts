import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execute } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import type { CandidateFile, EvidenceInput } from "../src/domain.js";
import { newUUIDv7 } from "../src/identity.js";
import { SQLStore } from "../src/sql-store.js";
import type { CandidateFixture } from "./fixture.js";
import { LedgerFixture, testAgent, testBaseline } from "./fixture.js";

interface FixtureCandidate {
  candidate_id: string;
  review_worktree: string;
  locations: Record<string, string>;
}

const usage = (): never => {
  throw new Error("usage: npx tsx test/review-host-fixture.ts <output-directory>");
};

const file = (path: string, change: CandidateFile["change"] = "modified"): CandidateFile => ({
  path_bytes: Buffer.from(path).toString("base64"),
  display_path: path,
  change,
  old_mode: "100644",
  new_mode: "100644",
});

const textPatch = (path: string, hunk: string): Buffer => Buffer.from([
  `diff --git a/${path} b/${path}`,
  "index 1111111..2222222 100644",
  `--- a/${path}`,
  `+++ b/${path}`,
  hunk,
  "",
].join("\n"));

const reviewWorktree = (
  root: string,
  name: string,
  databaseID: string,
  repositoryID: string,
  candidate: CandidateFixture,
): string => {
  const directory = join(root, `review-${name}`);
  execFileSync("git", ["init", "-q", directory]);
  writeFileSync(join(directory, ".git", "grounds-review.json"), `${JSON.stringify({
    format: "patchledger.review-worktree/v1",
    database_id: databaseID,
    candidate_id: candidate.candidate.candidate_id,
    repository_id: repositoryID,
    baseline_oid: candidate.run.context.baseline.git_oid,
    result_tree_oid: candidate.artifact.result_tree_oid,
    patch_digest: candidate.artifact.patch_digest,
  }, null, 2)}\n`, { mode: 0o600 });
  return directory;
};

const main = async (): Promise<void> => {
  const requested = process.argv[2];
  if (!requested) usage();
  const root = resolve(requested);
  if (existsSync(root) && readdirSync(root).length > 0) throw new Error(`output directory must be empty: ${root}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });

  const config = join(root, "config.yaml");
  const database = join(root, "ledger.db");
  await execute(["init", "--driver", "sqlite", "--non-interactive", "--config", config, "--path", database]);
  const fixture = await LedgerFixture.createWithStore(SQLStore.sqlite(database));
  try {
    const evidence: EvidenceInput[] = [{
      type: "command",
      command: "npm test -- review",
      exit_code: 0,
      output: "review checks passed",
    }];
    const orderPatch = textPatch("src/order.ts", [
      "@@ -41,2 +41,3 @@ async function placeOrder() {",
      " const order = await validate(input);",
      "+await transaction(async () => persist(order));",
      " return order;",
    ].join("\n"));
    const explained = await fixture.submitCandidate("explained", [file("src/order.ts")], evidence, true, orderPatch);
    await fixture.verify(explained, "qualified");
    await fixture.verify(explained, "rejected");

    const legacyPatch = textPatch("src/legacy.ts", [
      "@@ -7,2 +7,2 @@ function legacyPath() {",
      " const value = load();",
      "-return value;",
      "+return normalize(value);",
    ].join("\n"));
    const legacyIssue = await fixture.module.createIssue({
      operation_id: newUUIDv7(),
      attribution: testAgent,
      requirement_id: fixture.requirement.requirement_id,
      requirement_revision_id: fixture.requirement.requirement_revision_id,
      requirement_revision_explicit: true,
      repository_id: fixture.repository.repository_id,
      baseline: testBaseline,
      input: {
        format: 1,
        summary: "Historical issue without an Intent Link",
        goals: [{ statement: "Change legacy behavior", criteria: ["The legacy behavior changes"] }],
      },
    });
    const legacy = await fixture.submitCandidate(
      "legacy",
      [file("src/legacy.ts")],
      [],
      false,
      legacyPatch,
      legacyIssue.result,
    );

    const unverified = await fixture.submitCandidate("unverified", [file("src/order.ts")], evidence, true, orderPatch);

    const deletedPatch = textPatch("src/order.ts", [
      "@@ -18 +18,0 @@",
      "-await legacyGuard();",
    ].join("\n"));
    const deleted = await fixture.submitCandidate("deleted", [file("src/order.ts")], [], true, deletedPatch);

    const databaseID = loadConfig(config).database.expected_database_id;
    const candidates: Record<string, FixtureCandidate> = {
      explained: {
        candidate_id: explained.candidate.candidate_id,
        review_worktree: reviewWorktree(root, "explained", databaseID, fixture.repository.repository_id, explained),
        locations: { changed: "src/order.ts:42", context: "src/order.ts:41", unchanged: "src/order.ts:99" },
      },
      legacy: {
        candidate_id: legacy.candidate.candidate_id,
        review_worktree: reviewWorktree(root, "legacy", databaseID, fixture.repository.repository_id, legacy),
        locations: { changed: "src/legacy.ts:8" },
      },
      unverified: {
        candidate_id: unverified.candidate.candidate_id,
        review_worktree: reviewWorktree(root, "unverified", databaseID, fixture.repository.repository_id, unverified),
        locations: { changed: "src/order.ts:42" },
      },
      deleted: {
        candidate_id: deleted.candidate.candidate_id,
        review_worktree: reviewWorktree(root, "deleted", databaseID, fixture.repository.repository_id, deleted),
        locations: { deleted: "src/order.ts:18" },
      },
    };

    const binary = join(root, "grounds");
    const cli = fileURLToPath(new URL("../dist/src/main.js", import.meta.url));
    if (!existsSync(cli)) throw new Error(`built CLI not found; run npm run build first: ${cli}`);
    writeFileSync(binary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} "$@"\n`, { mode: 0o700 });
    chmodSync(binary, 0o700);

    const manifest = {
      format: "patchledger.review-host-fixture/v1",
      root,
      config,
      binary,
      candidates,
    };
    const manifestPath = join(root, "manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ manifest: manifestPath, ...manifest }, null, 2)}\n`);
  } finally {
    await fixture.close();
  }
};

await main();
