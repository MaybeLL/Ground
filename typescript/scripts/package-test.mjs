#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const output = mkdtempSync(join(tmpdir(), "grounds-package-"));
try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", output], { cwd: root, encoding: "utf8", env: { ...process.env, npm_config_cache: join(output, "npm-cache") } }));
  const tarball = join(output, packed[0].filename);
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }));
  if (manifest.name !== "@maybell/grounds" || manifest.version !== JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version) throw new Error("unexpected Grounds package identity");
  if (JSON.stringify(manifest.bin) !== JSON.stringify({ grounds: "dist/src/bin.js" })) throw new Error("tarball must expose only the grounds executable");
  const entries = execFileSync("tar", ["-tf", tarball], { encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) if (!entries.includes(`package/dist/${name}`)) throw new Error(`tarball is missing ${name}`);
  if (!entries.includes("package/native/host-process.c")) throw new Error("tarball is missing trusted-host process inspection source");
  for (const required of ["package/dist/src/bin.js", "package/dist/src/safe-tree.js", "package/binding.gyp", "package/native/peercred.c", "package/native/safe-tree.c", "package/dist/assets/grounds/skills/grounds/references/workflows/verify.md", "package/README.md"]) {
    if (!entries.includes(required)) throw new Error(`tarball is missing ${required}`);
  }
  if (entries.includes("package/vendor/mermaid.min.js")) throw new Error("tarball contains the retired contract renderer");
  const skillEntries = entries.filter(entry => /^package\/dist\/assets\/grounds\/skills\/[^/]+\/SKILL\.md$/.test(entry)).sort();
  const expectedNames = ["grounds"];
  const expectedSkills = expectedNames.map(name => `package/dist/assets/grounds/skills/${name}/SKILL.md`).sort();
  if (JSON.stringify(skillEntries) !== JSON.stringify(expectedSkills)) throw new Error("tarball must expose only the Grounds development skill");
  const workflows = {
    grounds: ["define", "develop", "verify", "deliver", "export-confluence"],
  };
  for (const [skill, names] of Object.entries(workflows)) {
    for (const name of names) {
      if (!entries.includes(`package/dist/assets/grounds/skills/${skill}/references/workflows/${name}.md`)) throw new Error(`missing workflow: ${skill}/${name}`);
    }
    for (const shared of ["preparation.md", "contracts/v1/common.schema.json"]) {
      if (!entries.includes(`package/dist/assets/grounds/skills/${skill}/references/${shared}`)) throw new Error(`missing shared reference: ${skill}/${shared}`);
    }
  }
  if (entries.some(entry => /^package\/dist\/assets\/grounds\/(references|scripts)\//.test(entry))) throw new Error("tarball contains an unassembled shared tree");
  if (entries.some(entry => /skills\/grounds\/(?:references\/evaluation|scripts\/grounds_eval_)/.test(entry)
    || /skills\/grounds-eval\/references\/(?:review-conversation|workflows\/develop)/.test(entry))) throw new Error("tarball contains another skill's private material");
  if (entries.some((entry) => /patchledger_agent|assets\/patchledger/.test(entry))) throw new Error("tarball contains an old public helper or asset path");
  if (entries.some(entry => /\/scripts\/(?:grounds_agent|grounds_knowledge|grounds_eval_[^/]+)\.py$/.test(entry))) throw new Error("tarball contains a retired agent coordinator or capture script");
  if (entries.some(entry => /(?:^|\/)code-route-client\.py$/.test(entry))) throw new Error("tarball contains the retired container route client");
  execFileSync("tar", ["-xf", tarball, "-C", output]);
  symlinkSync(join(root, 'node_modules'), join(output, 'package/node_modules'), 'dir');
  const installed = JSON.parse(execFileSync(process.execPath, [join(output, 'package/dist/src/bin.js'), 'install', 'skill', join(output, 'skills'), '--json'], {cwd: output, encoding: 'utf8'}));
  if (!installed.ok || JSON.stringify(installed.data.skills.map(skill => skill.name)) !== JSON.stringify(expectedNames)) throw new Error('packaged CLI did not install exactly the development skill');
  for (const skill of installed.data.skills) {
    if (skill.name === 'grounds') {
      if (!existsSync(join(skill.path, 'references/workflows/verify.md'))) throw new Error('installed independent gate guide missing');
      const help = JSON.parse(execFileSync(process.execPath, [join(output, 'package/dist/src/bin.js'), 'work', 'help', '--json'], {
        cwd: output, encoding: 'utf8', env: { ...process.env, GROUNDS_CONFIG: join(output, 'missing-config') },
      }));
      if (!help.ok || !help.data.usage.includes('work deliver') || !help.data.usage.includes('grade submit')) throw new Error('packaged CLI cannot discover the new work/gate commands without a ledger');
    }
    const entrypoint = readFileSync(join(skill.path, 'SKILL.md'), 'utf8');
    if (entrypoint.includes('../../references/')) throw new Error('installed entrypoint contains source-layout references');
    const markdownFiles = (directory) => readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
    });
    const bundledRoot = join(output, 'package/dist/assets/grounds/skills', skill.name);
    for (const path of markdownFiles(skill.path)) {
      const source = readFileSync(path, 'utf8');
      const bundled = readFileSync(resolve(bundledRoot, path.slice(skill.path.length + 1)), 'utf8');
      if (source !== bundled) throw new Error(`installed document differs from bundle: ${path}`);
      for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].split('#')[0];
        if (!target || /^[a-z]+:/i.test(target)) continue;
        if (!existsSync(resolve(dirname(path), target))) throw new Error(`broken installed reference: ${path} -> ${target}`);
      }
    }
  }

  for (const required of ["package/dist/src/repository-archive-github.js", "package/dist/assets/grounds/skills/grounds/references/github-archive-onboarding.md", "package/dist/src/gitlab-api.js", "package/dist/src/gitlab-tag-policy.js", "package/dist/src/repository-archive-access.js", "package/dist/src/repository-archive-cli.js", "package/dist/assets/grounds/skills/grounds/references/gitlab-archive-onboarding.md", "package/dist/assets/grounds/skills/grounds/references/contracts/v1/repository-archive.schema.json"]) {
    if (!entries.includes(required)) throw new Error(`tarball is missing ${required}`);
  }
  // Exercise the extracted package's public executable, not source imports, for
  // every CLI step of the GitLab binding and Candidate archive workflow.
  const archiveSmoke = execFileSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "--test-name-pattern", "GitLab onboarding", "test/candidate-archive-cli.test.ts"], {
    cwd: root, encoding: "utf8", timeout: 600_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GROUNDS_ARCHIVE_TEST_CLI: join(output, "package/dist/src/bin.js"), GROUNDS_ARCHIVE_TEST_TRANSCRIPT: process.env.GROUNDS_ARCHIVE_TEST_TRANSCRIPT ?? join(output, "archive-api-transcript.json") },
  });
  process.stdout.write(archiveSmoke);
  console.log(`package-test: ${packed[0].filename} exposes only grounds, contains the Grounds Skill bundle and passes packaged GitLab onboarding and Candidate archival.`);
} finally { rmSync(output, { recursive: true, force: true }); }
