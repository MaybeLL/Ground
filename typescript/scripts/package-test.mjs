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
  for (const required of ["package/dist/src/bin.js", "package/dist/src/safe-tree.js", "package/binding.gyp", "package/native/peercred.c", "package/native/safe-tree.c", "package/dist/assets/grounds/skills/grounds/scripts/grounds_agent.py", "package/dist/assets/grounds/skills/grounds-eval/scripts/grounds_eval_capture.py", "package/dist/assets/grounds/skills/grounds-eval/scripts/grounds_eval_import.py", "package/dist/assets/grounds/skills/grounds-eval/scripts/grounds_eval_run.py", "package/dist/assets/grounds/skills/grounds-eval/scripts/grounds_eval_environment.py", "package/dist/assets/grounds/skills/grounds-eval/scripts/grounds_eval_prepare_proxy.py", "package/dist/assets/grounds/skills/grounds-eval/scripts/grounds_eval_managed.py", "package/dist/assets/grounds/skills/grounds-eval/references/evaluation-qa.md", "package/dist/assets/grounds/skills/grounds-knowledge-improve/scripts/grounds_knowledge.py", "package/README.md"]) {
    if (!entries.includes(required)) throw new Error(`tarball is missing ${required}`);
  }
  // The review page inlines a pinned mermaid build, vendored as exactly one
  // file. It must ship (or diagrams silently never render), and mermaid itself
  // must never become a runtime dependency: its unpacked package is ~122 MB,
  // which is the cost the vendored build exists to avoid.
  if (!entries.includes("package/vendor/mermaid.min.js")) throw new Error("tarball is missing the vendored mermaid runtime");
  // The vendored directory holds the pinned runtime plus its third-party
  // licence notices; nothing else may creep in.
  const vendorEntries = entries.filter(entry => /^package\/vendor\//.test(entry));
  const inventory = JSON.parse(readFileSync(join(root, "vendor/mermaid-components.json"), "utf8"));
  const expectedVendor = new Set(["mermaid.min.js", "THIRD-PARTY-NOTICES.md", "MERMAID-LICENSE", "mermaid-components.json", ...Object.keys(inventory.license_files_sha256)].map(name => `package/vendor/${name}`));
  for (const entry of vendorEntries) if (!expectedVendor.has(entry)) throw new Error(`unexpected file in the vendored runtime directory: ${entry}`);
  for (const entry of expectedVendor) if (!entries.includes(entry)) throw new Error(`tarball is missing vendored runtime notice: ${entry}`);
  if (!entries.includes("package/vendor/THIRD-PARTY-NOTICES.md")) throw new Error("tarball is missing the vendored runtime's licence notices");
  // Existing is not enough: the contract names components that must be present.
  // A prior revision claimed completeness while omitting KaTeX and d3.
  const notices = readFileSync(join(root, "vendor", "THIRD-PARTY-NOTICES.md"), "utf8");
  for (const required of ["mermaid", "katex", "d3", "chevrotain", "es-toolkit", "dompurify", "cytoscape"]) {
    if (!notices.toLowerCase().includes(required)) throw new Error(`licence notices omit ${required}`);
  }
  if (entries.some(entry => /^package\/node_modules\/mermaid\//.test(entry))) throw new Error("tarball must not bundle mermaid as a runtime dependency");
  if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies?.mermaid) throw new Error("mermaid must not be a runtime dependency");
  const skillEntries = entries.filter(entry => /^package\/dist\/assets\/grounds\/skills\/[^/]+\/SKILL\.md$/.test(entry)).sort();
  const expectedNames = ["grounds", "grounds-eval", "grounds-knowledge-improve"];
  const expectedSkills = expectedNames.map(name => `package/dist/assets/grounds/skills/${name}/SKILL.md`).sort();
  if (JSON.stringify(skillEntries) !== JSON.stringify(expectedSkills)) throw new Error("tarball must expose the three Grounds skills");
  const workflows = {
    grounds: ["define", "develop", "verify", "deliver", "export-confluence"],
    "grounds-eval": ["eval-author", "eval-run"],
    "grounds-knowledge-improve": ["improve"],
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
  execFileSync("tar", ["-xf", tarball, "-C", output]);
  const clientHelp = execFileSync("python3", [join(output, "package/dist/assets/code-route-client.py"), "--help"], { encoding: "utf8" });
  if (!clientHelp.includes("stage") || !clientHelp.includes("retry")) throw new Error("packaged managed Git command unavailable");
  symlinkSync(join(root, 'node_modules'), join(output, 'package/node_modules'), 'dir');
  const installed = JSON.parse(execFileSync(process.execPath, [join(output, 'package/dist/src/bin.js'), 'install', 'skill', join(output, 'skills'), '--json'], {cwd: output, encoding: 'utf8'}));
  if (!installed.ok || JSON.stringify(installed.data.skills.map(skill => skill.name)) !== JSON.stringify(expectedNames)) throw new Error('packaged CLI did not install all three skills');
  for (const skill of installed.data.skills) {
    if (skill.name === 'grounds') {
      if (!existsSync(join(skill.path, 'references/code-workspace.md'))) throw new Error('installed Workspace guide missing');
      const help = JSON.parse(execFileSync('python3', [join(skill.path, 'scripts/grounds_agent.py'), 'invoke', '--cwd', output,
        '--', 'code-workspace', 'config-save', '--help'], { cwd: output, encoding: 'utf8',
        env: { ...process.env, GROUNDS_BIN: join(output, 'package/dist/src/bin.js'), GROUNDS_CONFIG: join(output, 'missing-config'),
          GROUNDS_AGENT_ID: '', GROUNDS_AGENT_NAME: '' } }));
      if (!help.ok || !help.data.usage.includes('config-save')) throw new Error('installed helper cannot discover Workspace commands without ledger or identity');
    }
    if (existsSync(join(skill.path, 'scripts/grounds_knowledge.py')) !== (skill.name === 'grounds-knowledge-improve')) throw new Error('knowledge helper bundled into wrong skill');
    if (skill.name === 'grounds-knowledge-improve') {
      const help = execFileSync('python3', [join(skill.path, 'scripts/grounds_knowledge.py'), '--help'], {cwd: output, encoding: 'utf8'});
      if (!help.includes('handoff') || !help.includes('compare')) throw new Error('installed knowledge helper unavailable');
      for (const role of ['doc', 'code']) mkdirSync(join(output, role, '.git'), {recursive: true});
      const worksheet = JSON.parse(execFileSync('python3', [join(skill.path, 'scripts/grounds_knowledge.py'), 'inputs',
        '--doc-repo', join(output, 'doc'), '--code-repo', join(output, 'code'), '--scope', 'packaged smoke',
        '--allow-doc', 'rules.md', '--out', join(output, 'private-run')], {cwd: output, encoding: 'utf8'}));
      const resumed = JSON.parse(execFileSync('python3', [join(skill.path, 'scripts/grounds_knowledge.py'), 'budget',
        '--inputs', join(output, 'private-run/inputs.json')], {cwd: output, encoding: 'utf8'}));
      if (worksheet.deadline_epoch !== resumed.deadline_epoch || resumed.remaining_seconds <= 0) throw new Error('installed worksheet budget did not survive resume');
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

  for (const script of ["grounds_eval_capture.py", "grounds_eval_import.py", "grounds_eval_run.py", "grounds_eval_environment.py", "grounds_eval_repositories.py"]) {
    const help = execFileSync("python3", [join(output, "package/dist/assets/grounds/skills/grounds-eval/scripts", script), "--help"], { cwd: output, encoding: "utf8" });
    if (!help.includes("usage:")) throw new Error(`packaged helper failed: ${script}`);
  }
  for (const required of ["package/dist/src/repository-archive-github.js", "package/dist/assets/grounds/skills/grounds/references/github-archive-onboarding.md", "package/dist/src/gitlab-api.js", "package/dist/src/gitlab-tag-policy.js", "package/dist/src/repository-archive-access.js", "package/dist/src/repository-archive-cli.js", "package/dist/assets/grounds/skills/grounds/references/gitlab-archive-onboarding.md", "package/dist/assets/grounds/skills/grounds/references/contracts/v1/repository-archive.schema.json"]) {
    if (!entries.includes(required)) throw new Error(`tarball is missing ${required}`);
  }
  // Exercise the extracted package's public executable, not source imports, for
  // every CLI step of the GitLab binding -> Candidate -> actual landing journey.
  const archiveSmoke = execFileSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "--test-name-pattern", "GitLab onboarding", "test/candidate-archive-cli.test.ts"], {
    cwd: root, encoding: "utf8", timeout: 600_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GROUNDS_ARCHIVE_TEST_CLI: join(output, "package/dist/src/bin.js"), GROUNDS_ARCHIVE_TEST_TRANSCRIPT: process.env.GROUNDS_ARCHIVE_TEST_TRANSCRIPT ?? join(output, "archive-api-transcript.json") },
  });
  process.stdout.write(archiveSmoke);
  console.log(`package-test: ${packed[0].filename} exposes only grounds, contains the Grounds Skill bundle and passes packaged GitLab onboarding/Candidate/landing archival.`);
} finally { rmSync(output, { recursive: true, force: true }); }
