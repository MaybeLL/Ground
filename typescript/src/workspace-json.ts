import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { validateBaseline, type IssueInput, type RequirementInput } from "./domain.js";
import { DomainError, validation } from "./errors.js";
import { isUUIDv7 } from "./identity.js";
import type { Manifest } from "./workspace.js";
import {
  parseIssueMarkdown,
  parseRequirementMarkdown,
} from "./workspace-markdown.js";

export const JSON_FORMAT = "grounds.authoring-workspace/v2";
export const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;
const LEGACY_FORMAT = "patchledger.authoring-workspace/v1";
export interface JsonDraft {
  requirement: RequirementInput;
  issues: {
    key: string;
    input: IssueInput;
    baselineExpression: string;
    questions: string[];
    assumptions: string[];
  }[];
}
export interface JsonManifest extends Manifest {
  draft: JsonDraft;
  revision: number;
  receipt?: unknown;
  external_issues?: string;
  conflicts?: unknown[];
  migration?: { backup: string; files: string[] };
}
export interface JsonSnapshot {
  manifest: JsonManifest;
  draft: JsonDraft;
  version: string;
}
const digest = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown): string =>
  JSON.stringify(value, null, 2) + "\n";
const record = (
  value: unknown,
  field: string,
  keys?: string[],
): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw validation(field, "must be an object");
  if (keys && Object.keys(value).some((key) => !keys.includes(key)))
    throw validation(field, "contains unknown or managed fields");
  return value as Record<string, any>;
};
const string = (value: unknown, field: string): void => {
  if (typeof value !== "string") throw validation(field, "must be a string");
};
const array = (value: unknown, field: string): any[] => {
  if (!Array.isArray(value)) throw validation(field, "must be an array");
  return value;
};
const strings = (value: unknown, field: string): void => {
  array(value, field).forEach((item) => string(item, field));
};
const optionalStrings = (value: Record<string, any>, keys: string[]): void => {
  for (const key of keys) if (value[key] !== undefined) string(value[key], key);
};
/** Structural validation deliberately permits incomplete prose; publication applies domain gates. */
export function validateJsonDraft(value: unknown): asserts value is JsonDraft {
  const draft = record(value, "draft", ["requirement", "issues"]);
  const req = record(draft.requirement, "requirement", [
    "format",
    "summary",
    "context",
    "outcomes",
    "decisions",
    "open_questions",
  ]);
  if (req.format !== 1) throw validation("requirement.format", "must equal 1");
  string(req.summary, "summary");
  optionalStrings(req, ["context"]);
  strings(req.outcomes, "outcomes");
  if (req.decisions !== undefined)
    for (const item of array(req.decisions, "decisions")) {
      const d = record(item, "decision", [
        "statement",
        "rationale",
        "context",
        "options",
        "chosen_option",
        "trade_offs",
        "consequences",
      ]);
      string(d.statement, "statement");
      optionalStrings(d, ["rationale", "context", "chosen_option"]);
      if (d.options !== undefined)
        for (const item of array(d.options, "options")) {
          const o = record(item, "option", [
            "key",
            "description",
            "benefits",
            "costs",
          ]);
          string(o.key, "key");
          string(o.description, "description");
          for (const k of ["benefits", "costs"])
            if (o[k] !== undefined) strings(o[k], k);
        }
      if (d.trade_offs !== undefined)
        for (const item of array(d.trade_offs, "trade_offs")) {
          const o = record(item, "trade_off", ["gain", "sacrifice", "reason"]);
          for (const k of ["gain", "sacrifice", "reason"]) string(o[k], k);
        }
      if (d.consequences !== undefined)
        for (const item of array(d.consequences, "consequences")) {
          const o = record(item, "consequence", ["kind", "statement"]);
          if (!["benefit", "obligation", "risk", "limitation"].includes(o.kind))
            throw validation("kind", "invalid consequence kind");
          string(o.statement, "statement");
        }
    }
  if (req.open_questions !== undefined)
    for (const item of array(req.open_questions, "open_questions")) {
      const q = record(item, "open_question", [
        "question",
        "blocking",
        "assumption",
      ]);
      string(q.question, "question");
      optionalStrings(q, ["assumption"]);
      if (typeof q.blocking !== "boolean")
        throw validation("blocking", "must be boolean");
    }
  const keys = new Set<string>();
  for (const item of array(draft.issues, "issues")) {
    const issue = record(item, "issue", [
      "key",
      "input",
      "baselineExpression",
      "questions",
      "assumptions",
    ]);
    if (
      typeof issue.key !== "string" ||
      !/^[^/\0]{1,200}$/.test(issue.key) ||
      [".", ".."].includes(issue.key) ||
      keys.has(issue.key)
    )
      throw validation("key", "must be unique safe Issue key");
    keys.add(issue.key);
    string(issue.baselineExpression, "baselineExpression");
    strings(issue.questions, "questions");
    strings(issue.assumptions, "assumptions");
    const input = record(issue.input, "issue.input", [
      "format",
      "summary",
      "context",
      "plan",
      "target_branch",
      "goals",
      "constraints",
    ]);
    if (input.target_branch !== undefined) {
      const target = record(input.target_branch, "issue.input.target_branch", ["remote", "ref"]);
      string(target.remote, "target_branch.remote");
      string(target.ref, "target_branch.ref");
    }
    if (input.format !== 1) throw validation("issue.format", "must equal 1");
    string(input.summary, "summary");
    optionalStrings(input, ["context", "plan"]);
    for (const kind of ["goals", "constraints"]) {
      if (kind === "constraints" && input[kind] === undefined) continue;
      for (const item of array(input[kind], kind)) {
        const target = record(item, kind, [
          "statement",
          "criteria",
          "guidance",
          "traces_to",
          ...(kind === "constraints" ? ["rationale"] : []),
        ]);
        string(target.statement, "statement");
        strings(target.criteria, "criteria");
        optionalStrings(target, ["rationale"]);
        if (target.guidance !== undefined) strings(target.guidance, "guidance");
        if (target.traces_to !== undefined)
          for (const item of array(target.traces_to, "traces_to")) {
            const link = record(item, "trace", ["type", "ordinal"]);
            if (
              !["outcome", "decision"].includes(link.type) ||
              !Number.isSafeInteger(link.ordinal) ||
              link.ordinal < 1
            )
              throw validation(
                "traces_to",
                "must reference an outcome or decision ordinal",
              );
            // Historical Issue bindings can refer to an earlier Requirement; range is checked at publication.
          }
      }
    }
  }
}
function safeText(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (fstatSync(fd).size > MAX_WORKSPACE_BYTES)
      throw validation(path, "exceeds 32 MiB");
    const data = readFileSync(fd);
    if (data.byteLength > MAX_WORKSPACE_BYTES)
      throw validation(path, "exceeds 32 MiB");
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } finally {
    closeSync(fd);
  }
}
function safeDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw validation(path, "must use a real directory, not a symbolic link");
}
function safeParents(root: string, target: string): void {
  const rel = relative(root, dirname(target));
  if (rel.split(sep).includes(".."))
    throw validation(target, "path escapes workspace");
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current)) safeDirectory(current);
  }
}
/** Validate managed source structures before either reading v2 or replacing a legacy source. */
function validateManagedSources(manifest: Manifest): void {
  record(manifest, "workspace");
  for (const field of ["name", "database_id"] as const) {
    if (typeof manifest[field] !== "string" || !manifest[field]) throw validation(field, "managed identity must be a nonempty string");
  }
  if (typeof manifest.repository_remote !== "string") throw validation("repository_remote", "must be a string");
  record(manifest.requirement, "requirement metadata", ["id", "revision_id", "version", "require_current", "base"]);
  if (manifest.requirement.require_current !== undefined && typeof manifest.requirement.require_current !== "boolean") throw validation("requirement.require_current", "must be boolean");
  if (manifest.requirement.base !== undefined) validateJsonDraft({ requirement: manifest.requirement.base, issues: [] });
  array(manifest.issues, "Issue metadata");
  for (const entry of [manifest.requirement, ...manifest.issues]) {
    record(entry, "managed metadata");
    for (const key of [
      "id",
      "revision_id",
      "requirement_revision_id",
      "desired_requirement_revision_id",
    ])
      if (
        (entry as any)[key] !== undefined &&
        (typeof (entry as any)[key] !== "string" ||
          !isUUIDv7((entry as any)[key]))
      )
        throw validation("workspace", "invalid managed identity");
    if (
      entry.version !== undefined &&
      (!Number.isSafeInteger(entry.version) || entry.version < 1)
    )
      throw validation("workspace", "invalid published version");
    if (
      Boolean(entry.id) !== Boolean(entry.revision_id) ||
      Boolean(entry.id) !== Boolean(entry.version)
    )
      throw validation("workspace", "incomplete published identity");
  }
  const keys = new Set<string>();
  for (const entry of manifest.issues) {
    if (!entry || typeof entry.key !== "string" || keys.has(entry.key))
      throw validation("workspace", "invalid managed Issue keys");
    if (!/^[^/\0]{1,200}$/.test(entry.key) || [".", ".."].includes(entry.key)) throw validation("issues.key", "unsafe key");
    record(entry, "Issue metadata", ["key", "file", "id", "revision_id", "version", "requirement_revision_id", "desired_requirement_revision_id", "base", "baseline"]);
    if (typeof entry.file !== "string" || !/^issues\/[^/\0]{1,200}\.md$/.test(entry.file)) throw validation("issues.file", "unsafe Issue path");
    if (entry.base !== undefined) validateJsonDraft({ requirement: { format: 1, summary: "", outcomes: [] }, issues: [{ key: entry.key, input: entry.base, baselineExpression: "", questions: [], assumptions: [] }] });
    if (entry.baseline !== undefined) {
      record(entry.baseline, "Issue baseline", ["git_oid", "reachability", "warning", "override_reason"]);
      validateBaseline(entry.baseline);
    }
    keys.add(entry.key);
  }
}
export function validateJsonManifest(manifest: JsonManifest): void {
  record(manifest, "workspace");
  if (manifest.format !== JSON_FORMAT)
    throw validation(
      "workspace.format",
      "JSON editor requires explicit workspace migration: run workspace migrate NAME (creates a legacy backup)",
    );
  if (
    !Number.isSafeInteger(manifest.revision) ||
    manifest.revision < 0 ||
    typeof manifest.name !== "string" ||
    !manifest.name ||
    typeof manifest.database_id !== "string" ||
    !manifest.database_id ||
    typeof manifest.repository_remote !== "string"
  )
    throw validation("workspace", "managed identity or revision is invalid");
  validateManagedSources(manifest);
  validateJsonDraft(manifest.draft);
  if (
    manifest.issues.some(
      (entry) =>
        entry.id &&
        !manifest.draft.issues.some((issue) => issue.key === entry.key),
    )
  )
    throw validation("issues", "published Issue cannot be removed");
}
function assertManifestSize(manifest: JsonManifest): void {
  const projected = {
    ...manifest,
    receipt: undefined,
    requirement: { ...manifest.requirement, base: manifest.draft.requirement },
    issues: manifest.draft.issues.map((draft) => ({
      ...manifest.issues.find((entry) => entry.key === draft.key),
      key: draft.key,
      base: draft.input,
      baseline: {
        git_oid: "sha1:" + "f".repeat(40),
        reachability: "remote_tracking_reachable",
      },
    })),
  };
  // Replace old bases in the projection; do not reserve another copy after publication.
  const future =
    Buffer.byteLength(encode(projected)) +
    65536 +
    manifest.draft.issues.length * 4096;
  if (
    Buffer.byteLength(encode(manifest)) > MAX_WORKSPACE_BYTES ||
    future > MAX_WORKSPACE_BYTES
  )
    throw validation(
      "workspace",
      "workspace and next publication state exceed 32 MiB",
    );
}
export function atomicManifestWrite(
  path: string,
  manifest: JsonManifest,
): void {
  validateJsonManifest(manifest);
  assertManifestSize(manifest);
  const text = encode(manifest);
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw validation(path, "must not be a symbolic link");
  let replaced = false;
  const tmp = `${path}.tmp-${randomUUID()}`;
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    replaced = true;
    const dir = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  } catch (error) {
    // The rename is the commit boundary; a later directory fsync error cannot
    // truthfully be reported as leaving the old file untouched.
    if (error && typeof error === "object") Object.assign(error, { commit_state: replaced ? "unknown" : "not_committed" });
    throw error;
  } finally {
    rmSync(tmp, { force: true });
  }
}
export class JsonWorkspaceStore {
  readonly path: string;
  constructor(readonly directory: string) {
    safeDirectory(directory);
    this.path = join(directory, ".workspace.json");
  }
  read(): JsonSnapshot {
    const bytes = safeText(this.path);
    let manifest: JsonManifest;
    try {
      manifest = JSON.parse(bytes);
    } catch {
      throw validation("workspace", "manifest is not valid JSON");
    }
    validateJsonManifest(manifest);
    assertManifestSize(manifest);
    return { manifest, draft: manifest.draft, version: digest(bytes) };
  }
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const { flock } = await import("fs-ext");
    const fd = openSync(
      join(this.directory, ".workspace.lock"),
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const deadline = Date.now() + 10000;
    try {
      for (;;) {
        try {
          await new Promise<void>((yes, no) =>
            flock(fd, "exnb", (error) => (error ? no(error) : yes())),
          );
          break;
        } catch (error: any) {
          if (!["EAGAIN", "EWOULDBLOCK"].includes(error.code)) throw error;
          if (Date.now() >= deadline)
            throw new DomainError("STATE_CONFLICT", "Workspace is busy", true);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      return await fn();
    } finally {
      closeSync(fd);
    }
  }
  writeUnlocked(
    manifest: JsonManifest,
    expectedVersion?: string,
  ): JsonSnapshot {
    if (
      expectedVersion !== undefined &&
      digest(safeText(this.path)) !== expectedVersion
    )
      throw new DomainError(
        "VERSION_CONFLICT",
        "Workspace changed; reload and reconcile your draft",
        false,
      );
    atomicManifestWrite(this.path, manifest);
    return this.read();
  }
  async update(
    expectedVersion: string,
    transform: (manifest: JsonManifest) => JsonManifest,
  ): Promise<JsonSnapshot> {
    return this.withLock(async () => {
      const current = this.read();
      if (current.version !== expectedVersion)
        throw new DomainError("VERSION_CONFLICT", "Workspace changed", false, {
          current_version: current.version,
        });
      const next = transform(current.manifest);
      next.revision = current.manifest.revision + 1;
      return this.writeUnlocked(next, expectedVersion);
    });
  }
  async resolve(
    draft: JsonDraft,
    expectedVersion: string,
  ): Promise<JsonSnapshot> {
    return this.save(draft, expectedVersion, true);
  }
  async save(
    draft: JsonDraft,
    expectedVersion: string,
    resolveConflicts = false,
  ): Promise<JsonSnapshot> {
    validateJsonDraft(draft);
    return this.withLock(async () => {
      const current = this.read();
      if (current.version !== expectedVersion)
        throw new DomainError(
          "VERSION_CONFLICT",
          "Workspace changed; reconcile unsaved input with the current draft",
          false,
          { current_version: current.version },
        );
      if (existsSync(join(this.directory, ".pending-publication.json")))
        throw new DomainError(
          "STATE_CONFLICT",
          "Publication recovery must finish before editing",
          false,
        );
      if (!resolveConflicts && current.manifest.conflicts?.length)
        throw new DomainError(
          "STATE_CONFLICT",
          "Unresolved rebase conflicts block saving; use workspace resolve with the reviewed draft and current version",
          false,
        );
      if (
        current.manifest.issues.some(
          (entry) =>
            entry.id && !draft.issues.some((item) => item.key === entry.key),
        )
      )
        throw validation("issues", "published Issue cannot be removed");
      const issues = draft.issues.map(
        (item) =>
          current.manifest.issues.find((entry) => entry.key === item.key) ?? {
            key: item.key,
            file: `issues/${item.key}.md`,
          },
      );
      return this.writeUnlocked(
        {
          ...current.manifest,
          ...(resolveConflicts ? { conflicts: [] } : {}),
          issues,
          draft,
          revision: current.manifest.revision + 1,
        },
        expectedVersion,
      );
    });
  }
  async migrateLegacy(
    dryRun = false,
  ): Promise<
    | JsonSnapshot
    | {
        dry_run: true;
        issue_count: number;
        path: string;
        from_format: string;
        to_format: string;
        backup_path: string;
        backup_files: string[];
        warning: string;
      }
  > {
    return this.withLock(async () => {
      const original = safeText(this.path);
      const old = JSON.parse(original) as Manifest;
      record(old, "workspace");
      if (old.format === JSON_FORMAT) {
        const current = this.read();
        if (!dryRun) this.finishMigration(current.manifest);
        return current;
      }
      if (old.format !== LEGACY_FORMAT)
        throw validation("format", "unsupported legacy Workspace format");
      if (existsSync(join(this.directory, ".pending-publication.json")))
        throw validation(
          "workspace",
          "recover pending publication before migration",
        );
      validateManagedSources(old);
      const files: Record<string, string> = { ".workspace.json": original };
      const read = (file: string): string => {
        const text = safeText(join(this.directory, file));
        if (/^(<<<<<<<|=======|>>>>>>>)/m.test(text))
          throw validation(file, "resolve merge conflicts before migration");
        files[file] = text;
        return text;
      };
      const req = parseRequirementMarkdown(read("requirement.md"));
      if (
        req.frontmatter.id !== old.requirement.id ||
        req.frontmatter.version !== old.requirement.version
      )
        throw validation("requirement", "managed identity changed");
      const issueDir = join(this.directory, "issues");
      safeDirectory(issueDir);
      const entries = old.issues.map((entry) => ({ ...entry }));
      const diskFiles = readdirSync(issueDir)
        .filter((file) => file.endsWith(".md"))
        .map((file) => `issues/${file}`);
      const parsedFiles = new Map(
        diskFiles.map((file) => [file, parseIssueMarkdown(read(file))]),
      );
      for (const entry of entries.filter((entry) => entry.id)) {
        const matches = diskFiles.filter(
          (file) => parsedFiles.get(file)!.frontmatter.id === entry.id,
        );
        if (matches.length !== 1)
          throw validation(
            "issues",
            "published Issue must have exactly one source document",
          );
        entry.file = matches[0];
      }
      for (const file of diskFiles)
        if (!entries.some((entry) => entry.file === file)) {
          if (parsedFiles.get(file)!.frontmatter.id)
            throw validation(
              file,
              "contains an identity not owned by this Workspace",
            );
          let key = file.slice("issues/".length, -3);
          while (entries.some((entry) => entry.key === key)) key += "-copy";
          entries.push({ key, file });
        }
      const issues = entries
        .filter(
          (entry) => entry.id || existsSync(join(this.directory, entry.file)),
        )
        .map((entry) => {
          if (!/^issues\/[^/\0]{1,200}\.md$/.test(entry.file))
            throw validation("issue.file", "unsafe path");
          const parsed = parseIssueMarkdown(read(entry.file));
          if (
            parsed.frontmatter.id !== entry.id ||
            parsed.frontmatter.version !== entry.version
          )
            throw validation(entry.file, "managed identity changed");
          return {
            key: entry.key,
            input: parsed.input,
            baselineExpression: parsed.baselineExpression,
            questions: parsed.questions,
            assumptions: parsed.assumptions,
          };
        });
      let receipt: unknown;
      if (existsSync(join(this.directory, "receipt.json"))) {
        receipt = JSON.parse(read("receipt.json"));
      }
      const external = existsSync(join(this.directory, "external-issues.md"))
        ? read("external-issues.md")
        : undefined;
      // Preserve duplicate historical bases as backup only; the manifest base remains authoritative.
      const collect = (dir: string): void => {
        safeDirectory(join(this.directory, dir));
        for (const name of readdirSync(join(this.directory, dir))) {
          const file = `${dir}/${name}`;
          const stat = lstatSync(join(this.directory, file));
          if (stat.isSymbolicLink())
            throw validation(file, "symbolic links are not migration inputs");
          if (stat.isDirectory()) collect(file);
          else files[file] = safeText(join(this.directory, file));
        }
      };
      if (existsSync(join(this.directory, ".base"))) collect(".base");
      const backup = `legacy/${digest(encode(files)).slice(0, 24)}`;
      const next: JsonManifest = {
        ...old,
        format: JSON_FORMAT,
        issues: entries.filter((entry) =>
          issues.some((issue) => issue.key === entry.key),
        ),
        revision: 1,
        draft: { requirement: req.input, issues },
        ...(receipt === undefined ? {} : { receipt }),
        ...(external === undefined ? {} : { external_issues: external }),
        migration: {
          backup,
          files: Object.keys(files).filter(
            (file) => file !== ".workspace.json",
          ),
        },
      };
      validateJsonManifest(next);
      assertManifestSize(next);
      if (dryRun)
        return {
          dry_run: true,
          issue_count: issues.length,
          path: this.directory,
          from_format: LEGACY_FORMAT,
          to_format: JSON_FORMAT,
          backup_path: join(this.directory, backup),
          backup_files: Object.keys(files),
          warning:
            "Stop old CLI processes and external writers before migration. Structured conversion preserves contract meaning, not original Markdown formatting bytes; the original text remains in the read-only backup.",
        };
      for (const folder of ["legacy", backup]) {
        const dir = join(this.directory, folder);
        if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
        safeDirectory(dir);
      }
      for (const [file, text] of Object.entries(files)) {
        const dest = join(this.directory, backup, file);
        safeParents(this.directory, dest);
        mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
        safeDirectory(dirname(dest));
        if (existsSync(dest) && safeText(dest) !== text)
          throw validation("backup", "existing migration backup differs");
        if (!existsSync(dest))
          writeFileSync(dest, text, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
          });
      }
      for (const [file, text] of Object.entries(files))
        if (safeText(join(this.directory, file)) !== text)
          throw new DomainError(
            "VERSION_CONFLICT",
            "Legacy files changed during migration",
            false,
          );
      atomicManifestWrite(this.path, next);
      this.finishMigration(next);
      return this.read();
    });
  }
  private finishMigration(manifest: JsonManifest): void {
    if (!manifest.migration) return;
    if (!/^legacy\/[a-f0-9]{24}$/.test(manifest.migration.backup))
      throw validation("migration", "unsafe backup path");
    safeDirectory(join(this.directory, "legacy"));
    safeDirectory(join(this.directory, manifest.migration.backup));
    for (const file of manifest.migration.files) {
      if (
        !/^(requirement\.md|receipt\.json|external-issues\.md|issues\/[^/]+\.md|\.base\/[A-Za-z0-9._/-]+)$/.test(
          file,
        ) ||
        file.split("/").includes("..")
      )
        throw validation("migration", "unsafe cleanup path");
      const source = join(this.directory, file);
      safeParents(this.directory, source);
      safeParents(
        this.directory,
        join(this.directory, manifest.migration.backup, file),
      );
      if (!existsSync(source)) continue;
      if (
        safeText(source) !==
        safeText(join(this.directory, manifest.migration.backup, file))
      )
        throw validation(
          file,
          "legacy file changed after conversion; preserve and reconcile manually",
        );
      rmSync(source);
    }
  }
}
