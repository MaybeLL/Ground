import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { validation } from "./errors.js";

export const skillNames = ["grounds", "grounds-eval", "grounds-knowledge-improve"] as const;
export type SkillName = typeof skillNames[number];

const evalScripts = [
  "grounds_eval_capture.py",
  "grounds_eval_import.py",
  "grounds_eval_run.py",
  "grounds_eval_environment.py",
  "grounds_eval_runtime.py",
  "grounds_eval_repositories.py",
  "grounds_eval_prepare_proxy.py",
  "grounds_eval_managed.py",
] as const;

export const scriptsForSkill = (name: SkillName): readonly string[] =>
  name === "grounds-eval" ? ["grounds_agent.py", ...evalScripts]
    : name === "grounds-knowledge-improve" ? ["grounds_agent.py", "grounds_knowledge.py"]
    : ["grounds_agent.py"];

const included = (path: string): boolean =>
  !["__pycache__", ".pytest_cache", ".DS_Store"].includes(basename(path)) && !path.endsWith(".pyc");

const files = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? (included(path) ? files(path) : []) : included(path) ? [path] : [];
  });

const within = (root: string, path: string): boolean => {
  const rest = relative(root, path);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
};

const sourceLayout = (root: string): boolean =>
  existsSync(join(root, "scripts", "grounds_agent.py"))
  && existsSync(join(root, "references", "preparation.md"))
  && existsSync(join(root, "references", "contracts", "v1"));

export const isSkillAssetsRoot = (root: string): boolean =>
  skillNames.every((name) => existsSync(join(root, "skills", name, "SKILL.md")))
  && (sourceLayout(root) || skillNames.every((name) =>
    existsSync(join(root, "skills", name, "references", "preparation.md"))
    && existsSync(join(root, "skills", name, "references", "contracts", "v1"))
    && scriptsForSkill(name).every((script) => existsSync(join(root, "skills", name, "scripts", script)))));

export const contractAssetsRoot = (root: string): string => sourceLayout(root)
  ? join(root, "references", "contracts", "v1")
  : join(root, "skills", "grounds", "references", "contracts", "v1");

const portable = (path: string): string => path.split(sep).join("/");

const rewriteMarkdownLinks = (text: string, relocate: (path: string) => string): string => {
  let fence: string | undefined;
  return text.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
      return line;
    }
    if (fence) return line;
    return line.replace(/`+[^`]*`+|(\[[^\]]*\]\()([^)]*)(\))/g, (match, prefix, path, suffix) =>
      prefix ? prefix + relocate(path) + suffix : match);
  }).join("\n");
};

/** Assemble one independent skill from source or copy an already assembled bundle. */
export const assembleSkillAssets = (root: string, name: SkillName, target: string): void => {
  const skillSource = resolve(root, "skills", name);
  const sharedSource = resolve(root, "references");
  cpSync(skillSource, target, { recursive: true, errorOnExist: true, filter: included });
  if (!sourceLayout(root)) return;

  const copies = new Map<string, string>();
  for (const path of files(skillSource)) copies.set(path, join(target, relative(skillSource, path)));
  for (const path of files(sharedSource)) {
    const destination = join(target, "references", relative(sharedSource, path));
    if (existsSync(destination)) throw validation("skill", `private and shared skill assets overlap: ${destination}`);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(path, destination, { errorOnExist: true });
    copies.set(path, destination);
  }
  mkdirSync(join(target, "scripts"), { recursive: true });
  for (const script of scriptsForSkill(name)) {
    cpSync(join(root, "scripts", script), join(target, "scripts", script), { errorOnExist: true });
  }

  // Resolve source links before relocating them. Only this skill, shared
  // references, and the other entrypoints are portable distribution resources.
  for (const [source, output] of copies) {
    if (!source.endsWith(".md")) continue;
    const text = rewriteMarkdownLinks(readFileSync(source, "utf8"), (destination) => {
      if (!destination || destination.startsWith("#") || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(destination)) return destination;
      const hash = destination.indexOf("#");
      const path = hash < 0 ? destination : destination.slice(0, hash);
      const fragment = hash < 0 ? "" : destination.slice(hash);
      const resolved = resolve(dirname(source), path);
      let relocated = copies.get(resolved);
      if (!relocated) {
        const other = skillNames.find((entry) => resolved === resolve(root, "skills", entry, "SKILL.md"));
        if (other) relocated = join(dirname(target), other, "SKILL.md");
      }
      if (!relocated || (!within(skillSource, resolved) && !within(sharedSource, resolved)
          && !skillNames.some((entry) => resolved === resolve(root, "skills", entry, "SKILL.md")))) {
        throw validation("skill", `skill reference is outside its distribution: ${source} -> ${destination}`);
      }
      return portable(relative(dirname(output), relocated)) + fragment;
    });
    writeFileSync(output, text);
  }
};
