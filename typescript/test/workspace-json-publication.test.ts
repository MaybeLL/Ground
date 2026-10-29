import { writeConfig } from "../src/config.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module } from "../src/module.js";
import { SQLStore } from "../src/sql-store.js";
import { WorkspaceModule } from "../src/workspace.js";
import { JsonWorkspaceStore } from "../src/workspace-json.js";
import { collectContractReview } from "../src/contract-review.js";
import { JsonPublication } from "../src/workspace-json-publication.js";
import { runCLI } from "../src/cli.js";
import { testAgent } from "./fixture.js";
import { newUUIDv7 } from "../src/identity.js";
import { assertContract } from "./schema-fixture.js";
import { DomainError } from "../src/errors.js";
async function fixture(fn: (o: any) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "grounds-json-publish-"));
  const git = (...a: string[]) =>
    execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  writeFileSync(join(root, "readme"), "x");
  git("add", ".");
  git("commit", "-qm", "init");
  git("remote", "add", "origin", "ssh://git@example.test/team/test");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const db = SQLStore.sqlite(join(root, "db"));
  try {
    const meta = await db.initialize("warn");
    writeConfig(join(root, "offline.yaml"), { version: 2, database: { driver: "sqlite", path: join(root, "unavailable", "db"), expected_database_id: meta.metadata.database_id } });
    const work = new Module(db);
    const ws = new WorkspaceModule(
      work,
      root,
      "warn",
      () => testAgent,
      meta.metadata.database_id,
      newUUIDv7,
      true,
    );
    const created = (await ws.new("draft")) as any;
    const local = new JsonWorkspaceStore(created.path);
    await fn({ root, db, work, ws, local, path: created.path });
  } finally {
    await db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
test("new JSON single source, exact reviewed publish, no-op, offline CLI and stale CAS", async () =>
  fixture(async ({ root, ws, local, path }) => {
    assert.deepEqual(
      readdirSync(path).filter(
        (x: string) => ![".workspace.lock", "issues", ".base"].includes(x),
      ),
      [".workspace.json"],
    );
    let snap = local.read();
    await assert.rejects(ws.publish("draft", root, false, false), /reviewed/);
    const pub = await ws.publish(
      "draft",
      root,
      false,
      false,
      false,
      "",
      undefined,
      snap.version,
    );
    assertContract("command-results.schema.json", pub.result);
    assert.equal(pub.result.requirement.version, 1);
    assert.equal(pub.result.issues[0].version, 1);
    assert.equal(existsSync(join(path, "receipt.json")), false);
    assert.equal(existsSync(join(path, ".pending-publication.json")), false);
    await assert.rejects(local.save(snap.draft, snap.version), /changed/);
    snap = local.read();
    assert.equal(
      (
        await ws.publish(
          "draft",
          root,
          false,
          false,
          false,
          "",
          undefined,
          snap.version,
        )
      ).result.no_op,
      true,
    );
    const output: string[] = [];
    assert.equal(
      await runCLI(
        [
          "workspace",
          "read",
          "draft",
          "--config",
          join(root, "offline.yaml"),
          "--json",
        ],
        { cwd: root, stdout: (x) => output.push(x), stderr: () => {} },
      ),
      0,
    );
    assertContract("cli-envelope.schema.json", JSON.parse(output.join("\n")));
    assert.equal(JSON.parse(output.join("\n")).data.version, snap.version);
  }));
test("committed response lost recovers identical operation; pending blocks edits", async () =>
  fixture(async ({ root, work, ws, local, path }) => {
    const original = work.publishAuthoring.bind(work);
    let n = 0;
    work.publishAuthoring = async (cmd: any) => {
      n++;
      await original(cmd);
      throw new Error("response lost");
    };
    const snap = local.read();
    await assert.rejects(
      ws.publish(
        "draft",
        root,
        false,
        false,
        false,
        "",
        undefined,
        snap.version,
      ),
      /response lost/,
    );
    await assert.rejects(local.save(snap.draft, snap.version), /recovery/);
    work.publishAuthoring = original;
    const recovered = await ws.publish(
      "draft",
      root,
      false,
      false,
      false,
      "",
      undefined,
      snap.version,
    );
    assert.equal(recovered.result.recovered, true);
    assert.equal(n, 1);
    assert.equal(recovered.result.requirement.version, 1);
  }));
test("retry clears terminal proof before uncertain failure", async () =>
  fixture(async ({ root, work, ws, local, path }) => {
    work.publishAuthoring = async () => {
      throw new DomainError("PREDECESSOR_CONFLICT", "stale");
    };
    const snap = local.read();
    await assert.rejects(
      ws.publish(
        "draft",
        root,
        false,
        false,
        false,
        "",
        undefined,
        snap.version,
      ),
      /stale/,
    );
    assert.equal(
      JSON.parse(readFileSync(join(path, ".pending-publication.json"), "utf8"))
        .terminal_failure,
      true,
    );
    work.publishAuthoring = async () => {
      throw new Error("connection lost");
    };
    await assert.rejects(
      ws.publish(
        "draft",
        root,
        false,
        false,
        false,
        "",
        undefined,
        snap.version,
      ),
      /connection lost/,
    );
    assert.equal(
      JSON.parse(readFileSync(join(path, ".pending-publication.json"), "utf8"))
        .terminal_failure,
      undefined,
    );
    await assert.rejects(
      new JsonPublication(work, path, root, "warn", () => testAgent).abandon(
        snap.version,
      ),
      /validation/,
    );
  }));
test("proven rejected publication explicitly abandons preserving draft", async () =>
  fixture(async ({ root, work, ws, local, path }) => {
    work.publishAuthoring = async () => {
      throw new DomainError("PREDECESSOR_CONFLICT", "stale");
    };
    const snap = local.read();
    await assert.rejects(
      ws.publish(
        "draft",
        root,
        false,
        false,
        false,
        "",
        undefined,
        snap.version,
      ),
    );
    assert.deepEqual(
      await new JsonPublication(
        work,
        path,
        root,
        "warn",
        () => testAgent,
      ).abandon(snap.version),
      { abandoned: true },
    );
    assert.deepEqual(local.read().draft, snap.draft);
    assert.equal(existsSync(join(path, ".pending-publication.json")), false);
  }));

test("rebase writes structured conflicts and explicit resolve permits reviewed publish", async () =>
  fixture(async ({ root, ws, local, work, path }) => {
    const initial = await ws.publish(
      "draft",
      root,
      false,
      false,
      false,
      "",
      undefined,
      local.read().version,
    );
    const other = (await ws.openRequirement(
      initial.result.requirement.id,
      "other",
    )) as any;
    const theirs = new JsonWorkspaceStore(other.path);
    let a = local.read();
    a.draft.requirement.summary = "Local summary";
    await local.save(a.draft, a.version);
    let b = theirs.read();
    b.draft.requirement.summary = "Remote summary";
    await theirs.save(b.draft, b.version);
    await ws.publish(
      "other",
      root,
      false,
      false,
      false,
      "",
      undefined,
      theirs.read().version,
    );
    const merged = (await ws.rebase("draft", root)) as any;
    assert.equal(merged.state, "conflicted");
    const conflict = local.read();
    assert.equal(conflict.draft.requirement.summary, "Local summary");
    assert.equal(conflict.manifest.conflicts.length, 1);
    assert.equal(
      readFileSync(join(path, ".workspace.json"), "utf8").includes("<<<<<<<"),
      false,
    );
    await assert.rejects(
      ws.publish(
        "draft",
        root,
        false,
        false,
        false,
        "",
        undefined,
        conflict.version,
      ),
    );
    await local.resolve(conflict.draft, conflict.version);
    const published = await ws.publish(
      "draft",
      root,
      false,
      false,
      false,
      "",
      undefined,
      local.read().version,
    );
    assert.equal(published.result.requirement.version, 3);
  }));

test("committed pending never overwrites external edits even using new expected version", async () =>
  fixture(async ({ root, work, ws, local, path }) => {
    const original = work.publishAuthoring.bind(work);
    work.publishAuthoring = async (cmd: any) => {
      await original(cmd);
      throw new Error("lost");
    };
    const before = local.read();
    await assert.rejects(
      ws.publish(
        "draft",
        root,
        false,
        false,
        false,
        "",
        undefined,
        before.version,
      ),
    );
    const raw = JSON.parse(readFileSync(join(path, ".workspace.json"), "utf8"));
    raw.draft.requirement.summary = "External input";
    writeFileSync(join(path, ".workspace.json"), JSON.stringify(raw));
    const changed = local.read();
    await assert.rejects(
      new JsonPublication(work, path, root, "warn", () => testAgent).abandon(
        changed.version,
      ),
    );
    assert.equal(local.read().draft.requirement.summary, "External input");
    assert.equal(existsSync(join(path, ".pending-publication.json")), true);
  }));

test("object key order is not a formal contract revision", async () =>
  fixture(async ({ root, ws, local }) => {
    await ws.publish(
      "draft",
      root,
      false,
      false,
      false,
      "",
      undefined,
      local.read().version,
    );
    const snap = local.read();
    const req = snap.draft.requirement;
    snap.draft.requirement = {
      outcomes: req.outcomes,
      summary: req.summary,
      format: 1,
    };
    await local.save(snap.draft, snap.version);
    const result = await ws.publish(
      "draft",
      root,
      false,
      false,
      false,
      "",
      undefined,
      local.read().version,
    );
    assert.equal(result.result.no_op, true);
  }));

test("rebase detects cross-field ordinal retarget instead of silently binding a different outcome", async () =>
  fixture(async ({ root, ws, local }) => {
    let start = local.read();
    start.draft.requirement.outcomes = ["A", "B"];
    await local.save(start.draft, start.version);
    const initial = await ws.publish(
      "draft",
      root,
      false,
      false,
      false,
      "",
      undefined,
      local.read().version,
    );
    const opened = (await ws.openRequirement(
      initial.result.requirement.id,
      "remote",
    )) as any;
    const remote = new JsonWorkspaceStore(opened.path);
    let ours = local.read();
    ours.draft.requirement.summary = "Local requirement";
    ours.draft.issues[0].input.summary = "Local issue";
    await local.save(ours.draft, ours.version);
    let theirs = remote.read();
    theirs.draft.requirement.outcomes = ["B", "A"];
    await remote.save(theirs.draft, theirs.version);
    await ws.publish(
      "remote",
      root,
      false,
      false,
      false,
      "",
      undefined,
      remote.read().version,
    );
    const merged = (await ws.rebase("draft", root)) as any;
    assert.equal(merged.state, "conflicted");
    assert.ok(merged.conflicts.some((x: string) => x.endsWith("traces_to")));
    const snapshot = local.read();
    assert.equal(
      snapshot.draft.issues[0].input.goals[0].traces_to?.[0].ordinal,
      1,
    );
    await assert.rejects(
      ws.publish(
        "draft",
        root,
        false,
        false,
        false,
        "",
        undefined,
        snapshot.version,
      ),
    );
    snapshot.draft.issues[0].input.goals[0].traces_to![0].ordinal = 2;
    await local.resolve(snapshot.draft, snapshot.version);
    await assert.rejects(ws.publish("draft", root, false, false, false, "", undefined, local.read().version));
    // Content resolution does not grant a source rebind. Choose current explicitly.
    const openedCurrent = await ws.openIssue(local.read().manifest.issues[0].id!, "resolved-current", "current");
    const selected = new JsonWorkspaceStore((openedCurrent as any).path);
    const selectedSnapshot = selected.read();
    const reconciled = local.read().draft;
    selectedSnapshot.draft.requirement = reconciled.requirement;
    selectedSnapshot.draft.issues[0].input = reconciled.issues[0].input;
    await selected.save(selectedSnapshot.draft, selectedSnapshot.version);
    const published = await ws.publish("resolved-current", root, false, false, false, "", undefined, selected.read().version);
    assert.equal((published.result as any).requirement.version, 3);
    assert.equal((published.result as any).issues[0].requirement.version, 3);
  }));

test("malformed pending proof is preserved instead of authorizing abandonment", async () =>
  fixture(async ({ root, work, ws, local, path }) => {
    work.publishAuthoring = async () => {
      throw new DomainError("PREDECESSOR_CONFLICT", "stale");
    };
    const snap = local.read();
    await assert.rejects(
      ws.publish(
        "draft",
        root,
        false,
        false,
        false,
        "",
        undefined,
        snap.version,
      ),
    );
    const file = join(path, ".pending-publication.json");
    const pending = JSON.parse(readFileSync(file, "utf8"));
    pending.terminal_failure = "true";
    writeFileSync(file, JSON.stringify(pending));
    await assert.rejects(
      new JsonPublication(work, path, root, "warn", () => testAgent).abandon(
        snap.version,
      ),
    );
    assert.equal(existsSync(file), true);
    assert.deepEqual(local.read().draft, snap.draft);
  }));

test("JSON dry-run and publication preserve unchanged historical Issue bindings", async () =>
  fixture(async ({ root, ws, local }) => {
    await ws.publish(
      "draft",
      root,
      false,
      false,
      false,
      "",
      undefined,
      local.read().version,
    );
    let snap = local.read();
    snap.draft.requirement.summary = "Requirement second";
    await local.save(snap.draft, snap.version);
    await ws.publish(
      "draft",
      root,
      false,
      false,
      false,
      "",
      undefined,
      local.read().version,
    );
    snap = local.read();
    snap.draft.issues[0].input.summary = "Issue second";
    await local.save(snap.draft, snap.version);
    const plan = await ws.publish(
      "draft",
      root,
      true,
      false,
      false,
      "",
      undefined,
      local.read().version,
    );
    assert.equal(plan.result.issues[0].requirement.version, 1);
    assertContract("command-results.schema.json", plan.result);
    const pub = await ws.publish(
      "draft",
      root,
      false,
      false,
      false,
      "",
      undefined,
      local.read().version,
    );
    assert.equal(pub.result.issues[0].requirement.version, 1);
  }));

test("committed local backfill with leftover journal can finish cleanup without republishing", async () =>
  fixture(async ({ root, work, ws, local, path }) => {
    const original = work.publishAuthoring.bind(work);
    let frozen: any;
    work.publishAuthoring = async (cmd: any) => {
      frozen = JSON.parse(
        readFileSync(join(path, ".pending-publication.json"), "utf8"),
      );
      return original(cmd);
    };
    await ws.publish(
      "draft",
      root,
      false,
      false,
      false,
      "",
      undefined,
      local.read().version,
    );
    writeFileSync(
      join(path, ".pending-publication.json"),
      JSON.stringify(frozen),
    );
    const result = await ws.publish(
      "draft",
      root,
      false,
      false,
      false,
      "",
      undefined,
      local.read().version,
    );
    assert.equal(result.result.recovered, true);
    assert.equal(existsSync(join(path, ".pending-publication.json")), false);
    writeFileSync(
      join(path, ".pending-publication.json"),
      JSON.stringify(frozen),
    );
    const drift = local.read().manifest;
    drift.draft.requirement.summary = "external after backfill";
    writeFileSync(join(path, ".workspace.json"), JSON.stringify(drift));
    await assert.rejects(
      ws.publish(
        "draft",
        root,
        false,
        false,
        false,
        "",
        undefined,
        local.read().version,
      ),
    );
    assert.equal(existsSync(join(path, ".pending-publication.json")), true);
  }));

test("historical references cannot silently follow simultaneous Requirement edits; explicit recovery paths remain usable", async () =>
  fixture(async ({ root, work, ws, local, path }) => {
    const publish = () => ws.publish("draft", root, false, false, false, "", undefined, local.read().version);
    let snap = local.read();
    snap.draft.requirement.outcomes = ["Outcome A", "Outcome B"];
    await local.save(snap.draft, snap.version);
    const first = await publish();
    const issueID = first.result.issues[0].id;
    const oldBinding = local.read().manifest.issues[0].requirement_revision_id;
    snap = local.read();
    snap.draft.requirement.summary = "Requirement version two";
    await local.save(snap.draft, snap.version);
    await publish();
    snap = local.read();
    snap.draft.requirement.outcomes.reverse();
    snap.draft.issues[0].input.summary = "Historical issue edit";
    await local.save(snap.draft, snap.version);
    const before = readFileSync(join(path, ".workspace.json"));
    const preview = await collectContractReview(work, { workspace: "draft", issues: [], output: root, format: "html" }, ws);
    const issueSection = preview.sections.find((section: any) => section.kind === "issue")!;
    assert.match(issueSection.binding!, /-v1$/);
    for (const dry of [true, false]) {
      await assert.rejects(ws.publish("draft", root, dry, false, false, "", undefined, local.read().version), (error: any) => String(error.details?.reason).includes("historically bound"));
    }
    assert.deepEqual(readFileSync(join(path, ".workspace.json")), before);
    assert.equal(existsSync(join(path, ".pending-publication.json")), false);
    // Preserve the old binding: stage the Issue edit, publish only Requirement,
    // restore the Issue edit and publish against the unchanged Requirement.
    const editedIssue = structuredClone(local.read().draft.issues[0].input);
    snap = local.read();
    snap.draft.issues[0].input = structuredClone(snap.manifest.issues[0].base);
    await local.save(snap.draft, snap.version);
    await publish();
    snap = local.read();
    snap.draft.issues[0].input = editedIssue;
    await local.save(snap.draft, snap.version);
    const retained = await publish();
    assert.equal(retained.result.issues[0].requirement.version, 1);
    assert.equal(local.read().manifest.issues[0].requirement_revision_id, oldBinding);
    assert.equal(local.read().draft.issues[0].input.goals[0].traces_to[0].ordinal, 1);
    // Deliberate rebind: use the existing checked operation, then reconcile A
    // to its position 2 in current Requirement B,A before publishing.
    const opened = await ws.openIssue(issueID, "rebound", "current");
    const rebound = new JsonWorkspaceStore(opened.path);
    snap = rebound.read();
    snap.draft.issues[0].input.goals[0].traces_to[0].ordinal = 2;
    snap.draft.requirement.summary = "Explicit current binding and Requirement edit";
    await rebound.save(snap.draft, snap.version);
    const result = await ws.publish("rebound", root, false, false, false, "", undefined, rebound.read().version);
    assert.equal(result.result.issues[0].requirement.version, 4);
    assert.equal(rebound.read().draft.issues[0].input.goals[0].traces_to[0].ordinal, 2);
  }));

test("a real delayed SQLite commit cannot be abandoned while its reply is lost", async () =>
  fixture(async ({ root, work, ws, local, path }) => {
    const original = work.publishAuthoring.bind(work);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let delayed: Promise<any> | undefined;
    work.publishAuthoring = async (command: any) => {
      delayed = gate.then(() => original(command));
      throw new Error("transport disconnected before delayed database commit");
    };
    const snap = local.read();
    await assert.rejects(ws.publish("draft", root, false, false, false, "", undefined, snap.version), /transport disconnected/);
    const pending = JSON.parse(readFileSync(join(path, ".pending-publication.json"), "utf8"));
    assert.equal(await work.completedAuthoringOperation(pending.operation_id), undefined);
    await assert.rejects(new JsonPublication(work, path, root, "warn", () => testAgent).abandon(snap.version));
    await assert.rejects(local.save(snap.draft, snap.version));
    assert.equal(existsSync(join(path, ".pending-publication.json")), true);
    release();
    const committed = await delayed;
    assert.equal(committed.result.requirement.version, 1);
    work.publishAuthoring = original;
    const recovered = await ws.publish("draft", root, false, false, false, "", undefined, snap.version);
    assert.equal(recovered.result.requirement.id, committed.result.requirement.id);
    assert.equal(recovered.result.requirement.version, 1);
    assert.equal(existsSync(join(path, ".pending-publication.json")), false);
    assert.equal((await work.currentRequirementRevision(committed.result.requirement.id)).revision_number, 1);
  }));
