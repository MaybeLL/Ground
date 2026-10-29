import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { execute, runCLI } from "../src/cli.js";
import { bundledPluginRoot, defaultSkillsDirectory, installGroundsSkills, legacySkillNames } from "../src/skill-installer.js";
import { assertContract } from "./schema-fixture.js";
import { assembleSkillAssets, contractAssetsRoot } from "../src/skill-assets.js";
import { DomainError } from "../src/errors.js";

const skillNames = ["grounds", "grounds-eval", "grounds-knowledge-improve"];
const sourcePluginRoot = fileURLToPath(new URL("../../plugins/grounds/", import.meta.url));
const workflows: Record<string, string[]> = {
  grounds: ["define", "develop", "verify", "auto-repair", "deliver", "export-confluence"],
  "grounds-eval": ["eval-author", "eval-run"],
  "grounds-knowledge-improve": ["improve"],
};

// Resolve a local Markdown link (optionally with a #fragment) from the file that contains it.
const assertLocalLink = (file: string, link: string, label: string): void => {
  const hash = link.indexOf("#");
  const path = hash < 0 ? link : link.slice(0, hash);
  const fragment = hash < 0 ? "" : link.slice(hash + 1);
  const target = path ? resolve(file, "..", path) : file;
  assert.equal(existsSync(target), true, `unresolved ${label} link: ${link}`);
  if (fragment) {
    assert.equal(readFileSync(target, "utf8").includes(`<a id="${fragment}"></a>`), true, `unresolved ${label} anchor: ${link}`);
  }
};

test("local link check resolves files, same-file fragments and rejects missing anchors", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-link-check-"));
  try {
    const source = join(directory, "a.md");
    writeFileSync(source, '<a id="here"></a>\n');
    writeFileSync(join(directory, "b.md"), '<a id="there"></a>\n');
    assertLocalLink(source, "b.md#there", "fixture");
    assertLocalLink(source, "#here", "fixture");
    assertLocalLink(source, "b.md", "fixture");
    assert.throws(() => assertLocalLink(source, "b.md#missing", "fixture"), /unresolved fixture anchor/);
    assert.throws(() => assertLocalLink(source, "#missing", "fixture"), /unresolved fixture anchor/);
    assert.throws(() => assertLocalLink(source, "c.md", "fixture"), /unresolved fixture link/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const markdownFiles = (root: string): string[] => readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const path = join(root, entry.name);
  return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith(".md") ? [path] : [];
});

const assertReferenceLinks = (root: string): void => {
  for (const path of markdownFiles(root)) {
    for (const [, destination] of readFileSync(path, "utf8").matchAll(/\]\(([^)]+)\)/g)) {
      const name = destination.split("#")[0];
      if (!name || /^[a-z][a-z0-9+.-]*:/i.test(name)) continue;
      assert.equal(existsSync(resolve(path, "..", name)), true, `unresolved reference: ${path} -> ${destination}`);
    }
  }
};

test("install skill uses the cross-agent global directory by default", () => {
  assert.equal(defaultSkillsDirectory("/home/example"), "/home/example/.agents/skills");
});

test("install skill creates self-contained skills at an explicit path and can update them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-skill-install-"));
  try {
    const result = await execute(["install", "skill", "agent-skills"], { cwd: directory }) as {
      target_path: string;
      skills: Array<{ name: string; path: string }>;
    };
    assertContract("command-results.schema.json", result);
    // Historical four-skill receipts remain readable.
    assertContract("command-results.schema.json", {
      ...result, skills: ["grounds-define", "grounds-develop", "grounds-verify", "grounds-deliver"].map(name => ({name, path: join(directory, name)})),
    });
    assert.equal(result.target_path, resolve(directory, "agent-skills"));
    assert.deepEqual(result.skills.map((skill) => skill.name), skillNames);

    for (const skill of result.skills) {
      assert.equal(existsSync(join(skill.path, "SKILL.md")), true);
      assert.equal(existsSync(join(skill.path, "agents", "openai.yaml")), true);
      assert.equal(existsSync(join(skill.path, "scripts", "grounds_agent.py")), true);
      assert.equal(existsSync(join(skill.path, "scripts", "grounds_knowledge.py")), skill.name === "grounds-knowledge-improve");
      for (const script of [
        "grounds_eval_capture.py",
        "grounds_eval_import.py",
        "grounds_eval_run.py",
        "grounds_eval_environment.py",
        "grounds_eval_repositories.py",
        "grounds_eval_prepare_proxy.py",
        "grounds_eval_managed.py",
      ]) assert.equal(existsSync(join(skill.path, "scripts", script)), skill.name === "grounds-eval");
      assert.equal(existsSync(join(skill.path, "references", "contracts", "v1", "cli-envelope.schema.json")), true);
      assert.match(readFileSync(join(skill.path, "SKILL.md"), "utf8"), /\$\{GROUNDS_SKILL_ROOT:-\$PLUGIN_ROOT\}/);
      const marker = JSON.parse(readFileSync(join(skill.path, ".grounds-managed.json"), "utf8")) as { package_version?: string };
      assert.match(marker.package_version ?? "", /^\d+\.\d+\.\d+/);
    }
    const evalSkill = result.skills.find(skill => skill.name === "grounds-eval")!;
    for (const script of [
      "grounds_eval_capture.py",
      "grounds_eval_import.py",
      "grounds_eval_run.py",
      "grounds_eval_environment.py",
      "grounds_eval_repositories.py",
    ]) {
      const help = execFileSync("python3", [join(evalSkill.path, "scripts", script), "--help"], { cwd: directory, encoding: "utf8" });
      assert.match(help, /usage:/);
    }
    const knowledge = result.skills.find(skill => skill.name === "grounds-knowledge-improve")!;
    const knowledgeHelp = execFileSync("python3", [join(knowledge.path, "scripts", "grounds_knowledge.py"), "--help"], { cwd: directory, encoding: "utf8" });
    assert.match(knowledgeHelp, /inputs.*budget.*subject.*handoff.*compare/);
    const development = result.skills.find((skill) => skill.name === "grounds")!;
    for (const name of ["self-contained-contracts.md", "confluence.md", "document-template.md", "review-conversation.md", "rationale-quality.md", "preparation.md"]) {
      assert.equal(existsSync(join(development.path, "references", name)), true);
    }
    assert.equal(existsSync(join(development.path, "evals")), false);
    for (const name of workflows.grounds) {
      assert.equal(existsSync(join(development.path, "references/workflows", `${name}.md`)), true);
    }
    assert.equal(existsSync(join(development.path, "references/evaluation.md")), false);
    assert.equal(existsSync(join(evalSkill.path, "references/review-conversation.md")), false);
    // Every static Markdown link resolves in both distribution layouts.
    for (const base of [bundledPluginRoot(), result.target_path]) {
      for (const name of skillNames) {
        const skillRoot = base === result.target_path ? join(base, name) : join(base, "skills", name);
        const text = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
        for (const [, link] of text.matchAll(/\]\(([^)]+)\)/g)) {
          assertLocalLink(join(skillRoot, "SKILL.md"), link, "entrypoint");
        }
        const referencesRoot = join(skillRoot, "references");
        for (const workflow of workflows[name]) {
          const directory = join(referencesRoot, "workflows");
          const body = readFileSync(join(directory, `${workflow}.md`), "utf8");
          for (const [, link] of body.matchAll(/\]\(([^)]+)\)/g)) {
            assertLocalLink(join(directory, `${workflow}.md`), link, `workflow ${workflow}`);
          }
        }
      }
    }
    const staleFile = join(result.skills[0].path, "stale.txt");
    writeFileSync(staleFile, "remove on update\n");
    await execute(["install", "skill", result.target_path]);
    assert.equal(existsSync(staleFile), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("source plugin and assembled bundle install the same self-contained, skill-specific resources", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-assembled-install-"));
  try {
    const bundle = join(directory, "bundle");
    for (const name of ["grounds", "grounds-eval", "grounds-knowledge-improve"] as const) {
      assembleSkillAssets(sourcePluginRoot, name, join(bundle, "skills", name));
    }
    const sourceInstall = installGroundsSkills(join(directory, "from-source"), sourcePluginRoot);
    const bundleInstall = installGroundsSkills(join(directory, "from-bundle"), bundle);
    assert.equal(readFileSync(join(contractAssetsRoot(bundle), "candidate-submission.schema.json"), "utf8"),
      readFileSync(join(contractAssetsRoot(sourcePluginRoot), "candidate-submission.schema.json"), "utf8"));
    for (const skill of sourceInstall.skills) {
      const packed = join(bundleInstall.target_path, skill.name);
      const expectedFiles = markdownFiles(skill.path).map(path => relative(skill.path, path)).sort();
      assert.deepEqual(markdownFiles(packed).map(path => relative(packed, path)).sort(), expectedFiles);
      for (const path of expectedFiles) assert.equal(readFileSync(join(packed, path), "utf8"), readFileSync(join(skill.path, path), "utf8"));
      assertReferenceLinks(skill.path);
      assertReferenceLinks(packed);
      assert.equal(readFileSync(join(packed, "references/contracts/v1/common.schema.json"), "utf8"),
        readFileSync(join(sourcePluginRoot, "references/contracts/v1/common.schema.json"), "utf8"));
      assert.match(readFileSync(join(packed, "SKILL.md"), "utf8"), /\]\(references\/preparation\.md\)/);
      const forbidden = skill.name === "grounds" ? "evaluation.md" : "review-conversation.md";
      assert.equal(existsSync(join(packed, "references", forbidden)), false);
    }
    const development = join(sourceInstall.target_path, "grounds");
    writeFileSync(join(development, "references/evaluation.md"), "old over-bundled evaluation reference");
    writeFileSync(join(development, "scripts/grounds_eval_run.py"), "old over-bundled helper");
    installGroundsSkills(sourceInstall.target_path, sourcePluginRoot);
    assert.equal(existsSync(join(development, "references/evaluation.md")), false);
    assert.equal(existsSync(join(development, "scripts/grounds_eval_run.py")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("conflicting private/shared resources fail before replacing a managed install", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-assets-overlap-"));
  try {
    const destination = join(directory, "installed");
    installGroundsSkills(destination, sourcePluginRoot);
    const entrypoint = readFileSync(join(destination, "grounds/SKILL.md"), "utf8");
    const conflictingSource = join(directory, "source");
    cpSync(sourcePluginRoot, conflictingSource, { recursive: true });
    writeFileSync(join(conflictingSource, "skills/grounds/references/preparation.md"), "conflicting shared protocol");
    assert.throws(() => installGroundsSkills(destination, conflictingSource), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.equal(error.details.field, "skill");
      assert.match(String(error.details.reason), /private and shared skill assets overlap/);
      return true;
    });
    assert.equal(readFileSync(join(destination, "grounds/SKILL.md"), "utf8"), entrypoint);
    assert.equal(readFileSync(join(destination, "grounds/references/preparation.md"), "utf8"),
      readFileSync(join(sourcePluginRoot, "references/preparation.md"), "utf8"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("assembly relocates shared links and fragments without changing code examples", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-assets-links-"));
  try {
    const source = join(directory, "source");
    cpSync(sourcePluginRoot, source, { recursive: true });
    const notes = join(source, "skills/grounds/references/notes.md");
    const example = "```text\n[example](../../../not-a-resource.md)\n```\n`[literal](../../../not-a-resource.md)`\n";
    writeFileSync(notes, "[shared](../../../references/preparation.md#shared-grounds-preparation)\n" + example);
    const target = join(directory, "assembled");
    assembleSkillAssets(source, "grounds", target);
    assert.equal(readFileSync(join(target, "references/notes.md"), "utf8"),
      "[shared](preparation.md#shared-grounds-preparation)\n" + example);
    writeFileSync(notes, "[other skill private file](../../grounds-eval/references/evaluation.md)\n");
    assert.throws(() => assembleSkillAssets(source, "grounds", join(directory, "invalid")), (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.equal(error.details.field, "skill");
      assert.match(String(error.details.reason), /outside its distribution/);
      return true;
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("install skill removes the retired managed refine skill", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-skill-upgrade-"));
  try {
    installGroundsSkills(directory, bundledPluginRoot());
    const retired = join(directory, "patchledger-refine");
    mkdirSync(retired);
    writeFileSync(join(retired, "SKILL.md"), "retired\n");
    writeFileSync(join(retired, ".patchledger-managed.json"), JSON.stringify({ format: "patchledger.skill-install/v1", skill: "patchledger-refine" }));

    const result = installGroundsSkills(directory, bundledPluginRoot());
    assert.deepEqual(result.skills.map((skill) => skill.name), skillNames);
    assert.equal(existsSync(retired), false);
    assert.equal(existsSync(join(directory, "grounds", "SKILL.md")), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("install skill atomically migrates managed legacy names", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-skill-migrate-"));
  try {
    const target = join(directory, "skills");
    mkdirSync(target, { recursive: true });
    for (const legacy of legacySkillNames) {
      const destination = join(target, legacy);
      mkdirSync(destination);
      writeFileSync(join(destination, "SKILL.md"), "legacy\n");
      writeFileSync(join(destination, ".patchledger-managed.json"), JSON.stringify({ format: "patchledger.skill-install/v1", skill: legacy }));
    }
    const result = installGroundsSkills(target, bundledPluginRoot());
    assert.deepEqual(result.skills.map((skill) => skill.name), skillNames);
    for (const legacy of legacySkillNames) assert.equal(existsSync(join(target, legacy)), false);
    for (const current of skillNames) assert.equal(existsSync(join(target, current, "SKILL.md")), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("install skill refuses to remove an unmanaged legacy name", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-skill-migrate-"));
  try {
    const target = join(directory, "skills");
    const legacy = join(target, legacySkillNames[0]);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "SKILL.md"), "user owned\n");
    assert.throws(
      () => installGroundsSkills(target, bundledPluginRoot()),
      (error: unknown) => error instanceof Error
        && "details" in error
        && typeof error.details === "object"
        && error.details !== null
        && "reason" in error.details
        && String(error.details.reason).includes("unmanaged legacy skill"),
    );
    assert.equal(readFileSync(join(legacy, "SKILL.md"), "utf8"), "user owned\n");
    for (const current of skillNames) assert.equal(existsSync(join(target, current)), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("link install replaces only canonical legacy links", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-skill-link-migrate-"));
  try {
    const canonical = join(directory, "canonical");
    const target = join(directory, "linked");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(target, { recursive: true });
    for (const legacy of legacySkillNames) {
      const destination = join(canonical, legacy);
      mkdirSync(destination);
      writeFileSync(join(destination, "SKILL.md"), "legacy\n");
      writeFileSync(join(destination, ".patchledger-managed.json"), JSON.stringify({ format: "patchledger.skill-install/v1", skill: legacy }));
      symlinkSync(destination, join(target, legacy));
    }
    installGroundsSkills(canonical, bundledPluginRoot());
    installGroundsSkills(target, bundledPluginRoot(), true, canonical);
    for (const legacy of legacySkillNames) assert.equal(lstatSync(join(target, legacy), { throwIfNoEntry: false }), undefined);
    for (const current of skillNames) assert.equal(lstatSync(join(target, current)).isSymbolicLink(), true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("link migration validates every legacy link before removing any", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-skill-link-atomic-"));
  try {
    const canonical = join(directory, "canonical");
    const target = join(directory, "linked");
    mkdirSync(canonical, { recursive: true });
    mkdirSync(target, { recursive: true });
    installGroundsSkills(canonical, bundledPluginRoot());

    const firstLegacy = join(target, legacySkillNames[0]);
    symlinkSync(join(canonical, legacySkillNames[0]), firstLegacy);
    const unmanagedLegacy = join(target, legacySkillNames[1]);
    symlinkSync(directory, unmanagedLegacy);

    assert.throws(
      () => installGroundsSkills(target, bundledPluginRoot(), true, canonical),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "VALIDATION_ERROR",
    );
    assert.equal(readlinkSync(firstLegacy), join(canonical, legacySkillNames[0]));
    assert.equal(readlinkSync(unmanagedLegacy), directory);
    for (const current of skillNames) assert.equal(lstatSync(join(target, current), { throwIfNoEntry: false }), undefined);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("install skill refuses to overwrite an unmanaged same-name directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-skill-unmanaged-"));
  try {
    const target = join(directory, "skills");
    const unmanaged = join(target, skillNames[0]);
    mkdirSync(unmanaged, { recursive: true });
    writeFileSync(join(unmanaged, "SKILL.md"), "user-owned\n");
    await assert.rejects(
      execute(["install", "skill", target]),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "VALIDATION_ERROR",
    );
    assert.equal(readFileSync(join(unmanaged, "SKILL.md"), "utf8"), "user-owned\n");
    assert.equal(existsSync(join(target, skillNames[1])), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("install skill --link creates symlinks to the canonical install", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-skill-link-"));
  try {
    const canonical = join(directory, "agents-skills");
    const target = join(directory, "claude-skills");
    const first = installGroundsSkills(canonical, bundledPluginRoot(), false);
    assert.equal(first.skills.length, skillNames.length);
    const result = installGroundsSkills(target, bundledPluginRoot(), true, canonical);
    assert.equal(result.skills.length, skillNames.length);
    for (const skill of result.skills) {
      const stat = lstatSync(skill.path);
      assert.equal(stat.isSymbolicLink(), true, `${skill.name} should be a symlink`);
      assert.equal(readlinkSync(skill.path), join(canonical, skill.name));
      assert.equal(existsSync(join(skill.path, "SKILL.md")), true);
    }
    // Re-running link mode is idempotent.
    const again = installGroundsSkills(target, bundledPluginRoot(), true, canonical);
    assert.equal(again.skills.length, skillNames.length);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("install skill --link is accepted through the public CLI", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-skill-link-cli-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = directory;
    const canonical = join(directory, ".agents", "skills");
    const target = join(directory, ".claude", "skills");
    await execute(["install", "skill", canonical], { cwd: directory });

    const output: string[] = [];
    const status = await runCLI(["install", "skill", target, "--link", "--json"], {
      cwd: directory,
      stdout: (line) => output.push(line),
      stderr: () => undefined,
    });
    assert.equal(status, 0);
    const envelope = JSON.parse(output[0]) as { ok: boolean; data: { skills: Array<{ name: string; path: string }> } };
    assertContract("cli-envelope.schema.json", envelope);
    assert.equal(envelope.ok, true);
    assert.deepEqual(envelope.data.skills.map((skill) => skill.name), skillNames);
    for (const skill of envelope.data.skills) {
      assert.equal(lstatSync(skill.path).isSymbolicLink(), true);
      assert.equal(readlinkSync(skill.path), join(canonical, skill.name));
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("install skill --link accepts equivalent relative symlinks through the public CLI", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-skill-relative-link-cli-"));
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = directory;
    const canonical = join(directory, ".agents", "skills");
    const target = join(directory, ".claude", "skills");
    await execute(["install", "skill", canonical], { cwd: directory });
    mkdirSync(target, { recursive: true });
    for (const skill of skillNames) {
      const destination = join(target, skill);
      symlinkSync(relative(target, join(canonical, skill)), destination);
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const output: string[] = [];
      const status = await runCLI(["install", "skill", target, "--link", "--json"], {
        cwd: directory,
        stdout: (line) => output.push(line),
        stderr: () => undefined,
      });
      assert.equal(status, 0);
      const envelope = JSON.parse(output[0]) as { ok: boolean; data: { skills: Array<{ name: string; path: string }> } };
      assertContract("cli-envelope.schema.json", envelope);
      assert.equal(envelope.ok, true);
      for (const skill of envelope.data.skills) {
        assert.equal(lstatSync(skill.path).isSymbolicLink(), true);
        assert.equal(readlinkSync(skill.path), relative(target, join(canonical, skill.name)));
      }
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("install skill --link still rejects a symlink to a different destination", () => {
  const directory = mkdtempSync(join(tmpdir(), "grounds-skill-wrong-link-"));
  try {
    const canonical = join(directory, "agents-skills");
    const target = join(directory, "claude-skills");
    installGroundsSkills(canonical, bundledPluginRoot(), false);
    mkdirSync(target, { recursive: true });
    const destination = join(target, skillNames[0]);
    symlinkSync(directory, destination);

    assert.throws(
      () => installGroundsSkills(target, bundledPluginRoot(), true, canonical),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "VALIDATION_ERROR",
    );
    assert.equal(readlinkSync(destination), directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("install skill validates extra paths and emits contract-valid JSON failures", async () => {
  const output: string[] = [];
  const status = await runCLI(["install", "skill", "/tmp/one", "/tmp/two", "--json"], {
    stdout: (line) => output.push(line),
    stderr: () => undefined,
  });
  assert.equal(status, 2);
  const envelope = JSON.parse(output[0]) as { ok: boolean; error: { code: string; details: { field: string } } };
  assertContract("cli-envelope.schema.json", envelope);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "VALIDATION_ERROR");
  assert.equal(envelope.error.details.field, "command");
});

test("copy migration restores retired skills when replacement fails", async () => {
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const { mock } = await import("node:test");
  const directory = mkdtempSync(join(tmpdir(), "grounds-copy-rollback-"));
  const original = fs.default.renameSync;
  try {
    const retired = join(directory, "grounds-define");
    mkdirSync(retired);
    writeFileSync(join(retired, "SKILL.md"), "previous skill");
    writeFileSync(join(retired, ".grounds-managed.json"), JSON.stringify({format: "patchledger.skill-install/v1", skill: "grounds-define", package_version: "0.2.7"}));
    const fault = mock.method(fs.default, "renameSync", (source: string, destination: string) => {
      if (destination === join(directory, "grounds-eval")) throw new Error("replacement failure");
      return original(source, destination);
    });
    syncBuiltinESMExports();
    try { assert.throws(() => installGroundsSkills(directory, bundledPluginRoot()), /replacement failure/); }
    finally { fault.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(readFileSync(join(retired, "SKILL.md"), "utf8"), "previous skill");
    for (const name of skillNames) assert.equal(existsSync(join(directory, name)), false);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test("link migration rolls back newly created links on failure", async () => {
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const { mock } = await import("node:test");
  const directory = mkdtempSync(join(tmpdir(), "grounds-link-rollback-"));
  const original = fs.default.symlinkSync;
  try {
    const canonical = join(directory, "canonical");
    const target = join(directory, "linked");
    installGroundsSkills(canonical, bundledPluginRoot());
    mkdirSync(target);
    symlinkSync(join(canonical, "grounds-define"), join(target, "grounds-define"));
    const fault = mock.method(fs.default, "symlinkSync", (source: string, destination: string) => {
      if (destination === join(target, "grounds-eval")) throw new Error("link failure");
      return original(source, destination);
    });
    syncBuiltinESMExports();
    try { assert.throws(() => installGroundsSkills(target, bundledPluginRoot(), true, canonical), /link failure/); }
    finally { fault.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(readlinkSync(join(target, "grounds-define")), join(canonical, "grounds-define"));
    for (const name of skillNames) assert.equal(lstatSync(join(target, name), {throwIfNoEntry: false}), undefined);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
