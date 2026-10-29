import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  constants,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { sha256 } from "./canonical-json.js";
import { JsonWorkspaceStore, type JsonManifest } from "./workspace-json.js";
import { DomainError, validation } from "./errors.js";
import {
  validateIssueInput,
  validateBaseline,
  validateRequirementInput,
  type Baseline,
  type Attribution,
  type RequirementInput,
  type IssueInput,
} from "./domain.js";
import {
  checkContentLanguage,
  issueProse,
  requirementProse,
  type ContentLanguagePolicy,
} from "./content-language.js";
import {
  discoverRepository,
  matchingRemoteNames,
  resolveBaseline,
  remoteTrackingReachable,
} from "./git.js";
import { validateTargetBranch } from "./target-branch.js";
import { newUUIDv7, isUUIDv7 } from "./identity.js";
import type {
  Module,
  PublishAuthoringCommand,
  PublishAuthoringResult,
  Warning,
} from "./module.js";
import {
  issueInputFromRevision,
  requirementInputFromRevision,
} from "./workspace-markdown.js";

interface Pending {
  format: string;
  operation_id: string;
  version: string;
  command: PublishAuthoringCommand;
  keys: string[];
  requirement: RequirementInput;
  terminal_failure?: boolean;
}
const equal = (a: unknown, b: unknown) =>
  a === undefined || b === undefined
    ? a === b
    : sha256(JSON.parse(JSON.stringify(a))) ===
      sha256(JSON.parse(JSON.stringify(b)));
const stateDigest = (manifest: JsonManifest): string => {
  const { receipt: _receipt, ...state } = manifest;
  return sha256(JSON.parse(JSON.stringify(state)));
};
const journal = (path: string, value: Pending) => {
  const temp = `${path}.tmp-${newUUIDv7()}`;
  const fd = openSync(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(temp, { force: true });
  }
};

function readPending(path: string): Pending {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let value: any;
  try {
    const bytes = readFileSync(fd);
    if (bytes.length > 32 * 1024 * 1024)
      throw validation("pending", "publication journal exceeds size limit");
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw validation(
      "pending",
      `cannot read publication journal: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    closeSync(fd);
  }
  if (
    !value ||
    value.format !== "grounds.pending-publication/v2" ||
    Object.keys(value).some(
      (k) =>
        ![
          "format",
          "operation_id",
          "version",
          "command",
          "keys",
          "requirement",
          "terminal_failure",
        ].includes(k),
    ) ||
    !isUUIDv7(value.operation_id) ||
    typeof value.version !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.version) ||
    (value.terminal_failure !== undefined &&
      typeof value.terminal_failure !== "boolean")
  )
    throw validation(
      "pending",
      "invalid publication identity or format; preserve journal and diagnose",
    );
  const cmd = value.command;
  if (
    !cmd ||
    cmd.operation_id !== value.operation_id ||
    typeof cmd.canonical_remote !== "string" ||
    !cmd.requirement ||
    typeof cmd.requirement !== "object" ||
    Array.isArray(cmd.requirement) ||
    !cmd.attribution ||
    !Array.isArray(cmd.issues) ||
    !Array.isArray(value.keys) ||
    cmd.issues.length !== value.keys.length ||
    value.keys.some((k: unknown) => typeof k !== "string" || !k) ||
    new Set(value.keys).size !== value.keys.length
  )
    throw validation("pending", "invalid frozen publication inputs");
  validateRequirementInput(value.requirement);
  if (
    cmd.requirement.input !== undefined &&
    !equal(cmd.requirement.input, value.requirement)
  )
    throw validation("pending", "frozen Requirement inputs differ");
  for (const issue of cmd.issues) {
    if (!issue || typeof issue !== "object")
      throw validation("pending", "invalid frozen Issue");
    validateIssueInput(issue.input);
    validateBaseline(issue.baseline);
  }
  return value as Pending;
}

export class JsonPublication {
  constructor(
    private work: Module,
    private path: string,
    private cwd: string,
    private policy: "warn" | "require_override",
    private actor: () => Attribution,
  ) {}
  private async result(value: PublishAuthoringResult, recovered = false) {
    const issues = [];
    for (const i of value.issues)
      issues.push({
        action: i.action,
        id: i.id,
        version: i.version,
        baseline: i.baseline,
        requirement: {
          id: value.requirement.id,
          version:
            i.requirement_revision_id === value.requirement.revision_id
              ? value.requirement.version
              : (
                  await this.work.contractRequirement(
                    value.requirement.id,
                    undefined,
                    i.requirement_revision_id,
                  )
                ).revision_number,
        },
      });
    return {
      result_type: "patchledger.result.workspace-publish/v1",
      command: "workspace.publish",
      requirement: {
        id: value.requirement.id,
        version: value.requirement.version,
        action: value.requirement.action,
      },
      issues,
      repository_id: value.repository_id,
      repository_action: value.repository_action,
      name: basename(this.path),
      path: this.path,
      ...(recovered ? { recovered: true } : {}),
    };
  }
  private finish(
    store: JsonWorkspaceStore,
    m: JsonManifest,
    p: Pending,
    result: PublishAuthoringResult,
    version: string,
  ) {
    m.requirement = {
      ...m.requirement,
      id: result.requirement.id,
      revision_id: result.requirement.revision_id,
      version: result.requirement.version,
      base: p.requirement,
    };
    result.issues.forEach((i, n) => {
      const e = m.issues.find((x) => x.key === p.keys[n]);
      const d = m.draft.issues.find((x) => x.key === p.keys[n]);
      if (!e || !d) throw validation("workspace", "pending Issue missing");
      Object.assign(e, {
        id: i.id,
        revision_id: i.revision_id,
        version: i.version,
        requirement_revision_id: i.requirement_revision_id,
        base: p.command.issues[n].input,
        baseline: i.baseline,
      });
      delete e.desired_requirement_revision_id;
      d.baselineExpression = i.baseline!.git_oid;
    });
    m.receipt = {
      operation_id: p.operation_id,
      content_digest: sha256(p.command),
      workspace_state_digest: stateDigest(m),
      result,
    };
    store.writeUnlocked(m, version);
    rmSync(join(this.path, ".pending-publication.json"));
  }
  async publish(
    expected: string,
    dryRun: boolean,
    allowUnpublished: boolean,
    allowSecond: boolean,
    reason: string,
    language?: ContentLanguagePolicy,
  ): Promise<{ result: unknown; warnings: Warning[] }> {
    const store = new JsonWorkspaceStore(this.path);
    return store.withLock(async () => {
      const snap = store.read();
      const m = snap.manifest;
      const pendingPath = join(this.path, ".pending-publication.json");
      if (existsSync(pendingPath)) {
        const p = readPending(pendingPath);
        if (p.command.canonical_remote !== m.repository_remote)
          throw validation(
            "pending",
            "frozen Repository differs from Workspace",
          );
        if (p.version !== snap.version) {
          // only atomic successful backfill can legitimately change it
          if (
            (m.receipt as any)?.operation_id === p.operation_id &&
            (m.receipt as any)?.workspace_state_digest === stateDigest(m)
          ) {
            const done = await this.work.completedAuthoringOperation(
              p.operation_id,
            );
            if (done) {
              rmSync(pendingPath);
              return {
                result: await this.result(done.result, true),
                warnings: done.warnings,
              };
            }
          }
          throw validation(
            "workspace",
            "pending publication input changed externally; preserve files and diagnose",
          );
        }
        if (dryRun)
          throw validation(
            "workspace",
            "pending publication must be recovered first",
          );
        const done = await this.work.completedAuthoringOperation(
          p.operation_id,
        );
        let published = done;
        if (!published) {
          delete p.terminal_failure;
          journal(pendingPath, p);
          try {
            published = await this.work.publishAuthoring(p.command);
          } catch (error) {
            if (
              error instanceof DomainError &&
              [
                "VALIDATION_ERROR",
                "PREDECESSOR_CONFLICT",
                "REPOSITORY_ISSUE_LIMIT",
                "STATE_CONFLICT",
              ].includes(error.code)
            ) {
              p.terminal_failure = true;
              journal(pendingPath, p);
            }
            throw error;
          }
        }
        this.finish(store, m, p, published.result, snap.version);
        return {
          result: await this.result(published.result, true),
          warnings: published.warnings,
        };
      }
      if (!expected || expected !== snap.version)
        throw new DomainError(
          "VERSION_CONFLICT",
          "reviewed Workspace version differs",
          false,
          { current_version: snap.version },
        );
      if (m.conflicts?.length)
        throw validation(
          "workspace",
          "resolve structured rebase conflicts first",
        );
      const req = m.draft.requirement;
      validateRequirementInput(req);
      const reqChanged = !equal(req, m.requirement.base);
      const repository = discoverRepository(this.cwd);
      const changed = [] as {
        key: string;
        input: IssueInput;
        baseline: Baseline;
        entry: JsonManifest["issues"][number];
      }[];
      for (const d of m.draft.issues) {
        const entry = m.issues.find((e) => e.key === d.key) ?? {
          key: d.key,
          file: `issues/${d.key}.md`,
        };
        validateIssueInput(d.input);
        if (d.input.target_branch) validateTargetBranch(repository.root, d.input.target_branch, await this.work.repositoryRemotesForResolution(m.repository_remote));
        if (d.questions.length || d.assumptions.length)
          throw validation(
            d.key,
            "resolve questions and assumptions before publication",
          );
        if (
          !equal(d.input, entry.base) ||
          d.baselineExpression !== entry.baseline?.git_oid ||
          entry.desired_requirement_revision_id
        ) {
          const binding = entry.desired_requirement_revision_id || entry.requirement_revision_id;
          if (reqChanged && entry.id && binding !== m.requirement.revision_id) {
            throw validation(
              d.key,
              "historically bound Issue and Requirement cannot change in one publication; " +
                "publish Requirement-only changes first, then restore and publish the Issue draft to retain its historical binding; " +
                "or explicitly open the Issue with --bind-requirement current in a separate Workspace and reconcile its references",
            );
          }
          const oid = resolveBaseline(repository.root, d.baselineExpression);
          const reachable = remoteTrackingReachable(
            repository.root,
            oid,
            matchingRemoteNames(repository, await this.work.repositoryRemotesForResolution(m.repository_remote)),
          );
          if (
            !reachable &&
            this.policy === "require_override" &&
            !allowUnpublished
          )
            throw new DomainError(
              "BASELINE_UNAVAILABLE",
              "baseline not remotely reachable",
            );
          if (!reachable && allowUnpublished && !reason.trim())
            throw validation("override-reason", "required");
          const baseline: Baseline = reachable
            ? { git_oid: oid, reachability: "remote_tracking_reachable" }
            : {
                git_oid: oid,
                reachability: "unconfirmed",
                warning: "baseline not remotely reachable",
                ...(reason ? { override_reason: reason } : {}),
              };
          changed.push({ key: d.key, input: d.input, baseline, entry });
        }
      }
      if (!reqChanged && !changed.length)
        return {
          result: {
            result_type: "patchledger.result.workspace-publish/v1",
            command: "workspace.publish",
            name: m.name,
            no_op: true,
            dry_run: dryRun,
          },
          warnings: [],
        };
      if (m.requirement.id && (m.requirement.require_current ?? true)) {
        const current = await this.work.currentRequirementRevision(
          m.requirement.id,
        );
        if (current.id !== m.requirement.revision_id)
          throw validation("workspace", "Requirement is stale; rebase first");
      }
      for (const c of changed)
        if (
          c.entry.id &&
          (await this.work.currentIssueRevision(c.entry.id)).id !==
            c.entry.revision_id
        )
          throw validation("workspace", "Issue is stale; rebase first");
      const warnings = checkContentLanguage(
        [
          ...(reqChanged ? requirementProse(req, "requirement") : []),
          ...changed.flatMap((c) => issueProse(c.input, c.key)),
        ],
        language,
      );
      warnings.push(
        ...(await this.work.preflightIssueRepositoryRule({
          requirement_id: m.requirement.id,
          canonical_remote: m.repository_remote,
          created_issue_count: changed.filter((c) => !c.entry.id).length,
          allow_second_issue_per_repository: allowSecond,
          override_reason: reason,
        })),
      );
      const bindingVersions = new Map<string, number>();
      for (const c of changed) {
        const bound =
          !reqChanged &&
          m.requirement.id &&
          (c.entry.desired_requirement_revision_id ||
            c.entry.requirement_revision_id)
            ? await this.work.contractRequirement(
                m.requirement.id,
                undefined,
                c.entry.desired_requirement_revision_id ||
                  c.entry.requirement_revision_id,
              )
            : req;
        bindingVersions.set(
          c.key,
          "revision_number" in bound
            ? bound.revision_number
            : (m.requirement.version ?? 0) + (reqChanged ? 1 : 0),
        );
        if (bound.open_questions?.some((q) => q.blocking))
          throw validation(
            "requirement",
            "blocking question prevents Issue publication",
          );
      }
      const cmd: PublishAuthoringCommand = {
        operation_id: newUUIDv7(),
        canonical_remote: m.repository_remote,
        reviewed_version: snap.version,
        requirement: {
          ...(m.requirement.id
            ? {
                requirement_id: m.requirement.id,
                expected_revision_id: m.requirement.revision_id,
                require_current: m.requirement.require_current ?? true,
              }
            : {}),
          ...(reqChanged ? { input: req } : {}),
        },
        issues: changed.map((c) => ({
          ...(c.entry.id
            ? {
                issue_id: c.entry.id,
                expected_revision_id: c.entry.revision_id,
              }
            : {}),
          ...(!reqChanged &&
          (c.entry.desired_requirement_revision_id ||
            c.entry.requirement_revision_id)
            ? {
                requirement_revision_id:
                  c.entry.desired_requirement_revision_id ||
                  c.entry.requirement_revision_id,
              }
            : {}),
          input: c.input,
          baseline: c.baseline,
        })),
        attribution: this.actor(),
        ...(allowSecond ? { allow_second_issue_per_repository: true } : {}),
        ...(reason ? { repository_issue_override_reason: reason } : {}),
      };
      if (dryRun)
        return {
          result: {
            result_type: "patchledger.result.workspace-plan/v1",
            command: "workspace.publish",
            name: m.name,
            dry_run: true,
            version: snap.version,
            requirement: {
              action: reqChanged
                ? m.requirement.id
                  ? "revise"
                  : "create"
                : "unchanged",
              version: (m.requirement.version ?? 0) + (reqChanged ? 1 : 0),
            },
            issues: changed.map((c) => ({
              id: c.entry.id,
              requirement: {
                id: m.requirement.id,
                version: bindingVersions.get(c.key)!,
              },
              action: c.entry.id ? "revise" : "create",
              version: (c.entry.version ?? 0) + 1,
            })),
          },
          warnings,
        };
      for (const c of changed)
        if (!m.issues.some((e) => e.key === c.key)) m.issues.push(c.entry);
      const p: Pending = {
        format: "grounds.pending-publication/v2",
        operation_id: cmd.operation_id!,
        version: snap.version,
        command: cmd,
        keys: changed.map((c) => c.key),
        requirement: req,
      };
      journal(pendingPath, p);
      let published;
      try {
        published = await this.work.publishAuthoring(cmd);
      } catch (error) {
        // Only application rejections returned after the awaited transaction has
        // unwound prove failure. Transport/internal errors remain uncertain.
        if (
          error instanceof DomainError &&
          [
            "VALIDATION_ERROR",
            "PREDECESSOR_CONFLICT",
            "REPOSITORY_ISSUE_LIMIT",
            "STATE_CONFLICT",
          ].includes(error.code)
        ) {
          p.terminal_failure = true;
          journal(pendingPath, p);
        }
        throw error;
      }
      this.finish(store, m, p, published.result, snap.version);
      return {
        result: await this.result(published.result),
        warnings: [...warnings, ...published.warnings],
      };
    });
  }
  async abandon(expected: string) {
    const s = new JsonWorkspaceStore(this.path);
    return s.withLock(async () => {
      const snap = s.read();
      if (snap.version !== expected) throw validation("version", "stale");
      const file = join(this.path, ".pending-publication.json");
      const p = readPending(file);
      if (p.command.canonical_remote !== snap.manifest.repository_remote)
        throw validation("pending", "frozen Repository differs from Workspace");
      if (p.version !== snap.version)
        throw validation(
          "pending",
          "external change detected; preserve and diagnose",
        );
      const done = await this.work.completedAuthoringOperation(p.operation_id);
      if (done) {
        this.finish(s, snap.manifest, p, done.result, snap.version);
        return { recovered: true };
      }
      if (!p.terminal_failure)
        throw validation(
          "pending",
          "outcome unknown; retry the same operation; absence of receipt is not proof",
        );
      rmSync(file);
      return { abandoned: true };
    });
  }
  async rebase() {
    const s = new JsonWorkspaceStore(this.path);
    return s.withLock(async () => {
      const snap = s.read();
      const m = snap.manifest;
      if (existsSync(join(this.path, ".pending-publication.json")))
        throw validation("pending", "recover publication first");
      if (!m.requirement.id)
        throw validation("workspace", "unpublished Workspace cannot rebase");
      if (m.conflicts?.length)
        throw validation("workspace", "resolve existing conflicts first");
      const conflicts: any[] = [];
      const previousRequirement = m.requirement.base;
      const localIssueChanges = new Set(
        m.draft.issues
          .filter((d) => {
            const entry = m.issues.find((e) => e.key === d.key);
            return (
              !equal(d.input, entry?.base) ||
              d.baselineExpression !== entry?.baseline?.git_oid
            );
          })
          .map((d) => d.key),
      );
      const merge = (base: any, local: any, remote: any, path: string) => {
        const out = { ...remote };
        for (const key of new Set([
          ...Object.keys(base ?? {}),
          ...Object.keys(local),
          ...Object.keys(remote),
        ])) {
          if (!equal(local[key], base?.[key])) {
            out[key] = local[key];
            if (
              !equal(remote[key], base?.[key]) &&
              !equal(remote[key], local[key])
            )
              conflicts.push({
                path: `${path}.${key}`,
                base: base?.[key],
                local: local[key],
                remote: remote[key],
              });
          }
        }
        return out;
      };
      const latest = await this.work.loadRequirement(m.requirement.id);
      if (latest.requirement_revision.id !== m.requirement.revision_id) {
        const remote = requirementInputFromRevision(
          latest.requirement_revision,
        );
        m.draft.requirement = merge(
          m.requirement.base,
          m.draft.requirement,
          remote,
          "requirement",
        );
        Object.assign(m.requirement, {
          base: remote,
          revision_id: latest.requirement_revision.id,
          version: latest.requirement_revision.revision_number,
        });
      }
      for (const e of m.issues) {
        if (!e.id) continue;
        const latest = await this.work.loadIssue(e.id);
        if (latest.issue_revision.id === e.revision_id) continue;
        const d = m.draft.issues.find((x) => x.key === e.key);
        if (!d) throw validation("workspace", "published Issue missing");
        const remote = issueInputFromRevision(latest.issue_revision);
        d.input = merge(e.base, d.input, remote, `issues.${e.key}.input`);
        const baseline = merge(
          { value: e.baseline?.git_oid },
          { value: d.baselineExpression },
          { value: latest.baseline.git_oid },
          `issues.${e.key}.baseline`,
        );
        d.baselineExpression = baseline.value;
        Object.assign(e, {
          base: remote,
          baseline: latest.baseline,
          revision_id: latest.issue_revision.id,
          version: latest.issue_revision.revision_number,
          requirement_revision_id:
            latest.issue_revision.requirement_revision_id,
        });
      }
      // Independent field merges must not silently retarget ordinal links when
      // the merged local Requirement and Issue will be published together.
      if (
        previousRequirement &&
        !equal(m.draft.requirement, m.requirement.base)
      ) {
        for (const issue of m.draft.issues.filter((d) =>
          localIssueChanges.has(d.key),
        )) {
          const affected = [
            ...issue.input.goals,
            ...(issue.input.constraints ?? []),
          ]
            .flatMap((t) => t.traces_to ?? [])
            .filter((link) => {
              const key = link.type === "outcome" ? "outcomes" : "decisions";
              return !equal(
                previousRequirement[key]?.[link.ordinal - 1],
                m.requirement.base?.[key]?.[link.ordinal - 1],
              );
            });
          if (affected.length)
            conflicts.push({
              path: `issues.${issue.key}.traces_to`,
              reason:
                "Requirement entries changed meaning or order; explicitly review these links before resolving",
              links: affected,
              base: {
                outcomes: previousRequirement.outcomes,
                decisions: previousRequirement.decisions,
              },
              remote: {
                outcomes: m.draft.requirement.outcomes,
                decisions: m.draft.requirement.decisions,
              },
            });
        }
      }
      m.conflicts = conflicts;
      s.writeUnlocked(m, snap.version);
      return {
        result_type: "patchledger.result.workspace-rebase/v1",
        command: "workspace.rebase",
        name: m.name,
        state: conflicts.length ? "conflicted" : "draft",
        conflicts: conflicts.map((c) => c.path),
      };
    });
  }
}
