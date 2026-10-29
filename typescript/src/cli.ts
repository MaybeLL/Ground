import { dataLayout, dataRoot, draftsRoot } from "./data-layout.js";
import { requireCurrentDataLayout } from "./data-layout-status.js";
import { executeDataMigration } from "./data-migration-cli.js";
import { resolveDevelopmentMode, resumeDevelopmentMode, validateDevelopmentMode, type DevelopmentModeSelection } from "./development-mode.js";
import { observeCodeRoute } from "./code-route-observation.js";
import { repositoryImageCommands, executeRepositoryImage } from "./repository-image-cli.js";
import { environmentControlCommands, executeEnvironmentControl } from "./repository-environment-cli.js";
import { RepositoryEnvironments, type RepositoryEnvironmentConfiguration } from "./repository-environment.js";
import { CodeRouteSyncWorkspace } from "./code-route-sync.js";
import { codeCleanupCommands, executeCodeCleanup } from "./code-workspace-cleanup-cli.js";
import { codeExecutionCommands, executeCodeExecution, codeExecutionExitCode } from "./code-route-cli.js";
import { CodeWorkspaceRoutes } from "./code-workspace-route.js";
import { RepositoryArchiveAccess } from "./repository-archive-access.js";
import { CodeWorkspaces } from "./code-workspace.js";
import { archivePolicyFor, executeRepositoryArchive, repositoryArchiveCommands } from "./repository-archive-cli.js";
import type { CompletionInput } from './completion.js';
import { CandidateArchiveService, archiveOperation } from "./candidate-archive-service.js";
import { ArchiveProtectionUnavailable, collectGitArchiveBinding, fetchGitArchive, inspectGitArchive, inspectLocalGitArchive, readArchiveProtectionPolicy, restoreGitArchive } from "./candidate-git-archive.js";
import { deriveLocalGitArtifact } from "./git-artifact-local.js";
import { candidateHistoryProjection } from "./candidate-history.js";
import { candidateDiff } from "./candidate-diff.js";
import { createDevelopmentPlan, readDevelopmentPlan, developmentPath, developmentBranchName, captureCommittedCandidate, captureCommittedDevelopment, retainCandidateSource, inspectCandidateSource, type DevelopmentIdentity, type DevelopmentPlan } from "./development-branch.js";
import { observeBranch, targetRelation } from "./integration-observation.js";
import { executeEnvironmentCommand } from "./env-cli.js";
import { isRouteWorkspace, isRouteLeased } from "./env-route-lease.js";
import { renderContractReview } from "./contract-review.js";
import { hostIdentity, runtimeRoot, safeRead, directoryRegistryRoot, withRuntimeLock } from './runtime-files.js';
import { runtimeError } from "./runtime-record.js";
import type { RuntimeRecord } from "./runtime-record.js";
import { executeEval, evalNeedsOperation, evalHelp, validateEvalArgs } from "./eval-cli.js";
import { executeQADraft, isQADraftCommand, qaDraftNeedsLedger, qaDraftNeedsOperation, qaDraftHelp, validateQADraftArgs } from './qa-draft-cli.js';
import { traceSource } from "./code-history-trace.js";
import { candidateFromReceipt, deliveryProof, withHistoryRead } from "./git-history.js";
import { DeliveryWorktreeModule } from "./delivery-worktree.js";
import type { DeliveryReceipt } from "./selection.js";
import { prepareReviewMarkdown, PreparedReviewMarkdown } from "./review-export.js";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { writeConfig, configPath, defaultSQLitePath, legacyConfigPath, loadConfig, mysqlPassword, networkPassword, validateConfig, type Config, type DatabaseConfig } from "./config.js";
import { candidateProse, checkContentLanguage, contentLanguagePolicy, qualityProse, verificationProse } from "./content-language.js";
import { asDomainError, DomainError, schemaDetails, validation, worktreeMismatch } from "./errors.js";
import { assertTargetBase } from "./target-branch.js";
import { snapshotRelation, readCommit } from "./integration-history.js";
import { IntegrationService } from "./integration-service.js";
import { DevRunSyncService } from "./devrun-sync-service.js";
import { PreflightService, observationData, assessmentData, type AssessInput } from "./preflight.js";
import type { LandingSource } from "./integration-gate.js";
import { assertReviewWorktreeCandidateArtifact, captureArtifact, discoverRepository, matchingRemoteNames, materializeCandidateWorktree, normalizeRemote, readReviewWorktreeMarker, remoteTrackingReachable, resolveBaseline, selectRemote, diffTrees, type ReviewWorktreeMarker, type WorktreeMode } from "./git.js";
import { isUUIDv7, newUUIDv7 } from "./identity.js";
import { Module, type PairwiseOptions, type SuccessEnvelope, type Warning } from "./module.js";
import { listUncommittedWork, reconcileDevRun, uncommittedReminder } from "./reconcile-service.js";
import { replayCheck } from "./replay-check.js";
import { SCHEMA_VERSION, SQLStore } from "./sql-store.js";
import type { IntegrityReport, Metadata } from "./store-types.js";
import { decodeCandidateSubmissionFile, decodeFile, decodeVerificationReportFile, validateOptionalLongText, type Attribution, type Baseline } from "./domain.js";
import { bundledPluginRoot, defaultSkillsDirectory, installGroundsSkills } from "./skill-installer.js";
import { createVerificationHandoff, decodeBlindContextFile, decodeVerificationHandoffFile, independentDigestOfContract, verificationTemplateFromBlindContext } from "./verification-handoff.js";
import { executeVerificationRun, isVerificationRunCommand, validateVerificationRunArgs, verificationRunHelp, verificationRunSubcommand } from "./verification-run-cli.js";
import { commandDigest, VerificationRunObserver, VerificationRuns } from "./verification-run.js";
import { createQualityHandoff, parseVerificationRole, decodeQualityHandoffFile, decodeQualityReviewReportFile, independentDigestOfQuality, QUALITY_CONTEXT_FORMAT, QUALITY_REPORT_FORMAT, qualityTemplateFromBlindContext, VERIFICATION_MODES, type VerificationMode } from "./quality-review.js";
import { safeYAMLToJS } from "./yaml-safe.js";
import { installationStatus } from "./installation-status.js";
import { cliVersion } from "./runtime-version.js";
import { JsonWorkspaceStore, JSON_FORMAT as JSON_WORKSPACE_FORMAT } from "./workspace-json.js";
import { startWorkspaceEditor } from "./workspace-editor.js";
import { WorkspaceModule } from "./workspace.js";
import { previewExternalWorkspace, captureWorkspaceArtifact } from "./workspace-provider.js";
import { DevWorktreeModule, commonRepositoryRoot } from "./dev-worktree.js";
import { ReviewSessions, writeMaterial, type ReviewPhase, type ReviewRole } from "./review-session.js";
import { renderReviewMarkdown, renderReviewTrace, renderReviewSummary, type ReviewSummaryResult, type ReviewLocationRequest, type ReviewTraceResult } from "./review.js";
import { migratePatchLedgerBrand, requireNoLegacyBrandState } from "./brand-migration.js";

export interface ParsedArgs { positionals: string[]; values: Record<string, string | boolean | string[]> }

export interface CLIIO {
  signal?: AbortSignal;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  cwd?: string;
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
}

const stdout = (io: CLIIO, line: string): void => (io.stdout ?? ((value) => process.stdout.write(value + "\n")))(line);
const stderr = (io: CLIIO, line: string): void => (io.stderr ?? ((value) => process.stderr.write(value + "\n")))(line);

const booleanOptionKeys = new Set(["early", "pinned", "allow-cached", "legacy-fixed","allow-unverified","preview","parallel-route","tty", "summary", "paged", "json", "markdown", "reconfigure", "allow-submitted", "allow-unpublished-baseline", "allow-second-issue-per-repository", "non-interactive", "confirm-initialize", "help", "link", "dry-run", "discard-changes", "include-diff", "refresh"]);

export const parseArgs = (argv: string[]): ParsedArgs => {
  const positionals: string[] = []; const values: Record<string, string | boolean | string[]> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { positionals.push(token); continue; }
    const raw = token.slice(2); const equal = raw.indexOf("="); const key = equal < 0 ? raw : raw.slice(0, equal); let value: string | boolean = equal < 0 ? true : raw.slice(equal + 1);
    // A lone `-` is the documented stdin sentinel for YAML/file options.  It
    // is not another option and must therefore be consumed as the value of
    // the preceding flag (`--file -`).  Negative numeric values are handled
    // the same way so their eventual range validation reports the right
    // field instead of the misleading "requires a value" error.
    const next = argv[index + 1];
    const nextIsValue = next === "-" || (next !== undefined && !next.startsWith("-")) || (next !== undefined && /^-\d/.test(next));
    if (value === true && !booleanOptionKeys.has(key) && nextIsValue) value = argv[++index];
    const previous = values[key];
    values[key] = previous === undefined ? value : [...(Array.isArray(previous) ? previous.map(String) : [String(previous)]), String(value)];
  }
  if (positionals[0] === "draft") positionals[0] = "workspace";
  return { positionals, values };
};

// Keep parsing deliberately small, but reject the two classes of typo that
// are most dangerous for a contract CLI: an unknown option silently falling
// back to a default and an extra positional silently being ignored.  The
// option allow-list is shared across commands because Grounds commands
// intentionally reuse a small set of attribution, storage and Git flags.
const knownOptionKeys = new Set(["development-mode", "early", "pinned", "retention-days", "plan-digest", "allow-cached", "configuration", "data-root", "instance", "issue-slug", "view", "observation-time", "landing-record", "archive-policy","legacy-fixed","allow-unverified","policy", "expected-head", "choice", "preview","adoption-file","plan", "parallel-route", "definition-commit", "target-remote", "target-branch",
  "workspace", "output", "format", "selection", "selection-version", "source-remote", "source-ref", "source-commit", "sync", "target-commit", "observation", "authorization", "provenance", "record",
  "external-directory", "input-digest", "directory", "snippet-file", "start-line", "end-line", "commit", "status", "state", "sort", "has-open-devrun", "standing", "selected", "verdict",
  "issue-version", "summary", "paged", "cursor", "after", "agent-id", "agent-name", "allow-second-issue-per-repository", "allow-submitted", "allow-unpublished-baseline", "at", "baseline", "base-commit", "baseline-policy", "bind-requirement", "branch", "brief", "brief-file", "canonical-remote", "candidate", "ca-file", "confirm-initialize", "config", "content-language", "language-override-reason", "context", "cwd", "database", "dev-run", "discard-changes", "driver", "dry-run", "event", "refresh", "expected-version", "exploration-brief", "file", "handoff", "help", "host", "include-diff", "include-patch", "include-verification", "issue", "issues-cursor", "json", "legacy-config", "limit", "link", "manifest-cursor", "markdown", "mode", "name", "non-interactive", "operation-id", "override-reason", "pairwise", "password-source", "path", "phase", "port", "preflight", "reason", "reconfigure", "refines-candidate", "remote", "remote-url", "repository", "requirement", "side", "skills-path", "subject-id", "subject-type", "tls", "tls-mode", "username", "verifications-cursor", "version", "role", "quality-handoff", "independent-digest", "out", "review-session",
  "run", "stage", "entry", "started-at", "ended-at", "exit-code", "identity", "asset", "lease", "hit", "copy-path", "report-digest",
  ...Object.values(codeCleanupCommands).flatMap(command => [...command.options]),
  ...Object.values(repositoryImageCommands).flatMap(command => [...command.options]),
  ...Object.values(environmentControlCommands).flatMap(command => [...command.options]),
]);

const validateOptionKeys = (args: ParsedArgs): void => {
  for (const key of Object.keys(args.values)) if (!knownOptionKeys.has(key)) throw validation(`--${key}`, "unknown option");
};

// A global allow-list catches spelling mistakes, but it is not enough for a
// stateful CLI: accepting a flag from a different command can silently select
// a default (for example `issue list --baseline ...`).  Keep the command
// surface explicit so every option is consumed by exactly one handler.
const commandOptionKeys: Record<string, Set<string>> = {
  ...Object.fromEntries(Object.entries(repositoryImageCommands).map(([action, spec]) => [`code-workspace:${action}`, new Set<string>(spec.options)])),
  ...Object.fromEntries(Object.entries(environmentControlCommands).map(([action, spec]) => [`code-workspace:${action}`, new Set<string>(spec.options)])),
  ...Object.fromEntries(Object.entries(codeExecutionCommands).map(([action, spec]) => [`code-workspace:${action}`, new Set<string>(spec.options)])),
  ...Object.fromEntries(Object.entries(codeCleanupCommands).map(([action, spec]) => [`code-workspace:${action}`, new Set<string>(spec.options)])),
  "code-workspace:route-prepare": new Set(["config", "data-root", "issue-slug", "operation-id", "agent-id", "agent-name"]),
  "code-workspace:route-show": new Set(["config"]),
  "code-workspace:route-bind": new Set(["development-mode", "config", "data-root", "operation-id", "agent-id", "agent-name"]),
  "code-workspace:environment-save": new Set(["config", "file", "repository", "expected-version", "operation-id", "agent-id", "agent-name"]),
  "code-workspace:environment-show": new Set(["config"]),
  "code-workspace:config-save": new Set(["config", "file", "expected-version", "operation-id", "agent-id", "agent-name"]),
  "code-workspace:config-show": new Set(["config", "version"]),
  "code-workspace:create": new Set(["config", "configuration", "version", "issue", "issue-version", "data-root", "operation-id", "agent-id", "agent-name"]),
  "code-workspace:restore": new Set(["config", "candidate", "context", "data-root", "operation-id", "agent-id", "agent-name"]),
  "code-workspace:show": new Set(["config"]),
  "code-workspace:prepare": new Set(["config", "data-root", "allow-cached"]),
  ...Object.fromEntries(Object.entries(repositoryArchiveCommands).map(([action, spec]) => [`repository:${action}`, new Set<string>(spec.options)])),
  "integration:observe": new Set(["config", "candidate", "selection", "selection-version", "source-remote", "source-ref", "source-commit", "refresh", "operation-id", "agent-id", "agent-name"]),
  "integration:authorize": new Set(["config", "observation", "reason", "operation-id", "agent-id", "agent-name"]),
  "integration:consume": new Set(["config", "authorization", "operation-id", "agent-id", "agent-name"]),
  "integration:landing": new Set(["archive-policy","adoption-file","config", "observation", "commit", "provenance", "refresh", "operation-id", "agent-id", "agent-name"]),
  "integration:show": new Set(["config", "record"]),
  "migrate:patchledger": new Set(["legacy-config", "dry-run"]),
  "migrate:data": new Set(["legacy-config", "dry-run", "file", "data-root"]),
  "delivery-link:withdraw": new Set(["config", "expected-version", "reason", "operation-id", "agent-id", "agent-name"]),
  "delivery-link:show": new Set(["config", "version"]),
  "delivery-link:record": new Set(["config", "candidate", "commit", "expected-version", "repository", "remote", "operation-id", "agent-id", "agent-name"]),
  "trace:": new Set(["config", "snippet-file", "at", "path", "start-line", "end-line", "repository", "remote", "limit"]),
  "init:": new Set(["config", "driver", "path", "reconfigure", "baseline-policy", "non-interactive", "confirm-initialize", "host", "port", "database", "username", "tls", "tls-mode", "ca-file", "password-source"]),
  "doctor:": new Set(["skills-path"]),
  "review:": new Set(["config", "candidate", "at", "side", "include-diff", "markdown", "summary"]),
  "install:skill": new Set(["link"]),
  "config:set-development-mode": new Set(["config", "development-mode"]),
  "workspace:bind": new Set(["config", "remote-url", "expected-version"]),
  "config:show": new Set(["config"]), "config:path": new Set(["config"]), "config:validate": new Set(["config"]),
  "db:status": new Set(["config"]), "db:test": new Set(["config"]), "db:migrate": new Set(["config"]),
  "contract:render": new Set(["config", "workspace", "output", "format", "requirement", "issue"]),
  "workspace:new": new Set(["format","config", "remote", "content-language"]),
  "workspace:open": new Set(["format","config", "name", "remote", "bind-requirement"]),
  "workspace:list": new Set(["config"]), "workspace:show": new Set(["config"]),
  "workspace:publish": new Set(["preflight", "refresh", "expected-version","config", "dry-run", "allow-unpublished-baseline", "allow-second-issue-per-repository", "override-reason", "content-language", "language-override-reason", "agent-id", "agent-name"]),
  "workspace:read": new Set(["config"]), "workspace:save": new Set(["config","file","expected-version"]), "workspace:edit": new Set(["config"]), "workspace:migrate": new Set(["config","dry-run"]), "workspace:resolve": new Set(["config","file","expected-version"]), "workspace:abandon-publication": new Set(["config","expected-version"]),
  "workspace:rebase": new Set(["config"]), "workspace:remove": new Set(["config", "discard-changes"]),
  "repository:register": new Set(["config", "remote", "operation-id", "agent-id", "agent-name"]),
  "repository:resolve": new Set(["config", "remote"]), "repository:list": new Set(["config", "limit", "cursor"]), "repository:show": new Set(["config", "repository"]),
  "repository:move": new Set(["config", "repository", "remote", "canonical-remote", "remote-url", "expected-version", "operation-id", "agent-id", "agent-name"]),
  "repository:alias-add": new Set(["config", "repository", "remote", "remote-url", "expected-version", "operation-id", "agent-id", "agent-name"]),
  "repository:alias-retire": new Set(["config", "repository", "remote", "remote-url", "expected-version", "operation-id", "agent-id", "agent-name"]),
  "requirement:list": new Set(["config", "limit", "cursor"]), "requirement:show": new Set(["config", "requirement", "issues-cursor"]),
  "selection:inspect": new Set(["config", "issue", "issue-version", "path"]),
  "completion:show": new Set(["config", "issue", "issue-version"]),
  "completion:record": new Set(["config", "issue", "issue-version", "file", "expected-version", "operation-id", "agent-id", "agent-name"]),
  "completion:reopen": new Set(["config", "issue", "issue-version", "reason", "expected-version", "operation-id", "agent-id", "agent-name"]),
  "selection:show": new Set(["config", "issue", "issue-version"]),
  "selection:set": new Set(["config", "issue", "issue-version", "candidate", "expected-version", "reason", "operation-id", "agent-id", "agent-name"]),
  "selection:clear": new Set(["config", "issue", "issue-version", "expected-version", "reason", "operation-id", "agent-id", "agent-name"]),
  "selection:materialize": new Set(["allow-unverified", "reason", "operation-id", "agent-id", "agent-name","config", "issue", "issue-version", "expected-version", "path", "branch"]),
  "issue:list": new Set(["config", "requirement", "repository", "status", "has-open-devrun", "sort", "limit", "cursor"]), "issue:show": new Set(["config", "issue", "issue-version"]),
  "devrun:sync-status": new Set(["config", "dev-run", "refresh"]),
  "devrun:sync-show": new Set(["config", "sync"]),
  "devrun:sync": new Set(["expected-head","config", "dev-run", "target-commit", "refresh", "expected-version", "operation-id", "agent-id", "agent-name"]),
  "devrun:sync-complete": new Set(["config", "sync", "file", "expected-version", "operation-id", "agent-id", "agent-name"]),
  "devrun:sync-abandon": new Set(["config", "sync", "expected-version", "operation-id", "agent-id", "agent-name"]),
  "devrun:inspect-workspace": new Set(["config", "issue", "repository", "remote", "directory"]),
  "devrun:continue": new Set(["config", "dev-run", "policy", "expected-head", "expected-version", "operation-id", "agent-id", "agent-name"]),
  "devrun:plan": new Set(["issue-slug", "config", "repository", "remote", "definition-commit", "target-remote", "target-branch", "branch", "refresh", "operation-id"]),
  "devrun:start": new Set(["development-mode", "refresh", "legacy-fixed","plan", "parallel-route", "base-commit", "config", "issue", "repository", "remote", "external-directory", "input-digest", "brief", "brief-file", "exploration-brief", "refines-candidate", "preflight", "operation-id", "agent-id", "agent-name"]),
  "devrun:context": new Set(["config", "dev-run", "include-verification"]), "devrun:abandon": new Set(["config", "dev-run", "expected-version", "reason", "operation-id", "agent-id", "agent-name"]),
  "devrun:cleanup": new Set(["choice", "preview","config", "dev-run", "discard-changes", "operation-id", "agent-id", "agent-name"]), "devrun:reconcile": new Set(["config", "dev-run"]), "devrun:uncommitted": new Set(["config"]), "devrun:list": new Set(["config", "issue", "issue-version", "repository", "state", "limit", "cursor"]), "devrun:show": new Set(["config", "dev-run"]),
  "devrun:prepare": new Set(["development-mode", "brief", "brief-file", "exploration-brief", "config", "dev-run", "issue", "repository", "remote", "plan", "refines-candidate", "parallel-route", "base-commit", "operation-id", "agent-id", "agent-name"]),
  "devrun:admit": new Set(["config", "dev-run", "preflight", "refresh", "expected-version", "expected-head", "operation-id", "agent-id", "agent-name"]),
  "preflight:observe": new Set(["dev-run", "config", "phase", "refresh", "issue", "issue-version", "repository", "remote", "target-remote", "target-branch", "workspace", "expected-version", "operation-id", "agent-id", "agent-name"]),
  "preflight:assess": new Set(["config", "observation", "file", "operation-id", "agent-id", "agent-name"]),
  "preflight:show": new Set(["config"]),
  "candidate:submit": new Set(["archive-policy","config", "dev-run", "file", "expected-version", "content-language", "language-override-reason", "operation-id", "agent-id", "agent-name"]),
  "candidate:archive": new Set(["config", "candidate", "archive-policy", "dry-run", "operation-id", "agent-id", "agent-name"]),
  "candidate:diff": new Set(["config", "candidate", "view", "target-commit", "observation-time", "landing-record"]),
  "candidate:archive-status": new Set(["config", "candidate", "refresh"]),
  "candidate:archive-operation": new Set(["config", "operation-id"]),
  "candidate:fetch": new Set(["config", "candidate"]),
  "candidate:restore": new Set(["config", "candidate", "path", "branch"]),
  "candidate:lineage": new Set(["config", "candidate"]),
  "candidate:materialize": new Set(["config", "candidate", "mode", "path", "branch"]), "candidate:artifact": new Set(["config", "candidate"]), "candidate:replay-check": new Set(["config", "candidate", "issue", "issue-version", "refresh"]), "candidate:show": new Set(["config", "candidate", "manifest-cursor", "verifications-cursor"]),
  "candidate:list": new Set(["config", "issue", "issue-version", "repository", "standing", "selected", "limit", "cursor"]), "candidate:compare": new Set(["candidate", "config", "include-patch", "pairwise", "summary"]),
  "candidate:template": new Set(["config", "dev-run", "content-language"]),
  "verification:submit": new Set(["config", "candidate", "file", "handoff", "quality-handoff", "mode", "content-language", "language-override-reason", "operation-id", "agent-id", "agent-name"]), "verification:context": new Set(["config", "candidate", "phase", "role", "out", "review-session"]),
  "verification:show": new Set(["config", "verification"]), "verification:list": new Set(["config", "candidate", "paged", "cursor", "verdict", "limit"]), "verification:template": new Set(["config", "candidate", "context", "content-language", "role"]),
  "verification:handoff": new Set(["file", "content-language", "language-override-reason", "agent-id", "agent-name", "independent-digest", "out", "review-session"]), "verification:independent-digest": new Set(["file"]),
  "verification:run-start": new Set(["config", "candidate", "role", "review-session", "agent-id", "agent-name"]), "verification:run-show": new Set(["config", "run"]), "verification:run-list": new Set(["config", "candidate", "role", "review-session"]),
  "verification:run-stage": new Set(["config", "run", "stage", "state", "reason"]), "verification:run-command": new Set(["config", "run", "stage", "entry", "started-at", "ended-at", "exit-code", "state"]),
  "verification:run-environment": new Set(["config", "run", "identity", "asset", "lease", "hit", "reason", "state"]), "verification:run-freeze": new Set(["config", "run", "independent-digest", "copy-path"]),
  "verification:run-handoff": new Set(["config", "run", "report-digest", "state", "path"]), "verification:run-submit": new Set(["config", "run", "state", "operation-id", "verification"]),
  "ledger:list": new Set(["config", "after", "repository", "subject-type", "subject-id", "limit"]), "ledger:show": new Set(["config", "event"]),
};

// One-line documentation for every option the CLI understands.  Subcommand
// help surfaces these so a caller never has to read source to discover the
// contract.  Attribution/storage/Git flags are shared across commands and
// documented once here.
const optionDocs: Record<string, string> = {
  "early": "Bypass retention time only; pinning and preservation checks still apply",
  "pinned": "Keep instance code from collection (true/false)",
  "retention-days": "Days from the original end time, default 7, range 0–3650",
  "plan-digest": "Exact digest returned by cleanup-preview; use its lifecycle version",
  "allow-cached": "Explicitly accept available cached commits after a failed repository refresh; never grants development admission",
  "configuration": "Persistent code Workspace configuration UUID",
  "data-root": "Grounds data root; macOS and Linux default to ~/.grounds; GROUNDS_DATA_HOME overrides the default",
  instance: "Explicit credential-free HTTPS GitLab instance (default selected binding or repository host); credentials are resolved for the current user and this instance",
  "archive-policy": "Operator-verified archive protection policy JSON; reread and validate repository, ref namespace, validity, ACL and team-read evidence before remote archival",
  "legacy-fixed": "Explicit legacy pinned target-start compatibility; never a fallback for a new managed plan. Existing legacy operations replay without this flag",
  "target-remote": "Explicit user-confirmed target remote of the registered Repository",
  "target-branch": "Explicit full refs/heads/... target branch; no main/master/checkout guessing",
  "allow-unverified": "Explicit single preparation exception; requires reason and stable operation ID and binds Candidate/source/Selection/refreshed target; does not change Verification",
  "policy": "Explicit author continuation policy: parallel or paused; a replay returns its historical receipt, inspect devrun context for the current policy",
  "expected-head": "Qualified HEAD observed for author continuation, synchronization or preflight admission; stale values are rejected",
  "choice": "Cleanup choice: worktree (retain branch), worktree-and-branch, or keep",
  "preview": "Read-only cleanup preview; does not remove a worktree or branch",
  "adoption-file": "Explicit adoption evidence JSON; binds Repository, target, source, L and method; FF requires target_predecessor evidence to confirm the real target update predecessor",
  "plan": "Confirmed local development plan UUID; creates exactly its managed path and branch",
  "parallel-route": "Use a separate planned managed route instead of continuing the parent route",
  "issue-slug": "Readable English issue name for grounds/<issue-slug>/<route-key>; route key is generated from the plan identity",
  "definition-commit": "Fixed full commit used to analyze the contract; does not silently follow a target ref",
  "snippet-file": "UTF-8 file containing pasted code (maximum 64 KiB)",
  "start-line": "First source line (one-based, default 1)",
  "end-line": "Last source line, inclusive (default start-line)",
  "commit": "Full 40- or 64-character commit OID; exactly one parent required",
  "agent-id": "Attribution for an Agent caller (with --agent-name)",
  "agent-name": "Display name for an Agent caller (with --agent-id)",
  "allow-submitted": "Unused placeholder kept for option-allowlist parity",
  "allow-unpublished-baseline": "Permit a baseline that is not reachable from a remote-tracking ref",
  "allow-second-issue-per-repository": "Permit a second Issue for one Requirement on the same Repository; requires --override-reason",
  "baseline": "Git revision to use as the Issue baseline (default HEAD)",
  "baseline-policy": "warn or require_override for unconfirmed baselines",
  "branch": "Delivery branch name (candidate materialize delivery mode)",
  "brief": "Inline DevRun exploration brief",
  "base-commit": "First target-flow start must equal the freshly assessed target commit; refinement preparation restores its parent Candidate base",
  "view": "Fixed comparison: candidate, original, upstream, evolution, cumulative, landing, or target",
  "observation-time": "ISO observation time for an explicitly supplied target commit; does not imply integrated or delivery-ready",
  "landing-record": "Exact recorded landing UUID for landing difference",
  "target-commit": "Qualified fixed target commit OID for explicit sync or observed-target comparison",
  "sync": "Durable DevRun sync record ID; complete/abandon use its version",
  "selection": "Selection ID bound to an integration observation",
  "selection-version": "Expected Selection version bound to an integration observation",
  "source-remote": "Git remote for the actual integration source branch",
  "source-ref": "Full refs/heads/... source branch ref; distinct from the Issue target",
  "source-commit": "Qualified source commit OID; managed source must match archived commit/ordered parents/result tree and contain Candidate base; requires the exact source commit of the Git artifact",
  "observation": "Saved integration gate observation ID",
  "authorization": "One-time integration authorization ID; consumption refreshes facts and never merges",
  "provenance": "Landing identity source: user, merge_result, or target_is_source; first-parent checks still apply",
  "record": "Immutable integration record ID to inspect",
  "brief-file": "Path to a DevRun exploration brief file",
  "ca-file": "MySQL/PostgreSQL TLS CA file",
  "candidate": "Candidate ID (positional or --candidate)",
  "canonical-remote": "New canonical remote for repository move",
  "config": "Path to the Grounds config file",
  "content-language": "Check human-authored prose for the requested language (currently zh-CN); opt in for Chinese review workflows",
  "language-override-reason": "Explicit reason to accept flagged English prose with --content-language zh-CN",
  "legacy-config": "Path to a PatchLedger v1 config to migrate",
  "context": "Saved blind VerificationContext JSON (offline template mode)",
  "confirm-initialize": "Explicitly confirm initializing an empty MySQL/PostgreSQL database",
  "cwd": "Working directory for Git operations",
  "database": "MySQL/PostgreSQL database name",
  "dev-run": "DevRun ID (positional or --dev-run)",
  "driver": "Storage driver: sqlite, mysql or postgres",
  "event": "Ledger event ID to show (positional or --event)",
  "expected-version": "Expected version for optimistic-concurrency writes",
  "exploration-brief": "Compatibility alias for --brief",
  "file": "Path to a YAML/JSON input file ('-' for stdin)",
  "handoff": "Signed verifier handoff JSON (alternative to --file); in ultra mode the contract part",
  "quality-handoff": "Signed quality-review handoff JSON (required with --mode ultra)",
  "review-session": "verification context/handoff: write into this existing review session directory (the review_session_id returned by candidate materialize --mode review)",
  "role": "Verification role: contract (default) or quality (ultra code-quality reviewer)",
  "independent-digest": "verification handoff: reject the report unless the digest of its independent (blind) part matches this value",
  "help": "Show help for the command (or global help)",
  "host": "MySQL/PostgreSQL host",
  "include-patch": "Include a Candidate's patch in a comparison",
  "include-diff": "Include the Candidate's unified diff when it is bounded text",
  "include-verification": "Include a Verification ID in a refinement context",
  "issue": "Issue ID; contract render: repeat ID@VERSION to select exact Issues",
  "workspace": "Contract draft name (contract render)",
  "output": "Output directory outside the authoring Workspace; content-addressed filenames",
  "format": "Workspace new/open: json (default) or markdown; contract render: html (default) or markdown",
  "at": "Review: PATH[:LINE]; trace: PATH:START[-END]",
  "issues-cursor": "Opaque page cursor for issue listing",
  "json": "Emit a machine-readable patchledger.cli/v1 envelope",
  "summary": "Review facts without report bodies; candidate compare: ledger-only summary without local Git",
  "paged": "Read a Candidate-bound Verification directory page",
  "cursor": "Continue a fixed Verification directory (--paged), or a cursor-paged resource list: pass the previous page's next_cursor with the same filters",
  "markdown": "Render a portable read-only review summary for a Markdown file or PR body",
  "limit": "Maximum results; trace checks up to 200 Candidates (default 200). On list commands it selects paged mode: 1-1000 items per page (default 100 when only --cursor is given). Order: Issue by ID ascending (or latest activity first with --sort activity); DevRun/Requirement/Repository by ID ascending; Candidate/Verification by created_at then ID ascending",
  "link": "Create links to the canonical ~/.agents/skills install instead of copying a second managed copy",
  "manifest-cursor": "Opaque page cursor for a Candidate file manifest",
  "mode": "candidate materialize: existing, review, or delivery; verification submit: normal (default) or ultra",
  "development-mode": "Choose simple (current environment) or container for this DevRun",
  "non-interactive": "Never prompt; use supplied values or defaults",
  "operation-id": "Caller-supplied UUIDv7 idempotency key",
  "override-reason": "Reason text for an unconfirmed baseline and for --allow-second-issue-per-repository (legacy alias of --reason)",
  "pairwise": "left:right Candidate pair for pairwise comparison",
  "password-source": "MySQL/PostgreSQL password source: environment or keychain",
  "out": "verification context/handoff: write the result object to this file as well as stdout (exclusive with --review-session)",
  "path": "Directory path (install skill target, materialize target; optional in review mode, where the CLI names a review session)",
  "phase": "Verification phase: blind or reconcile",
  "port": "MySQL/PostgreSQL port",
  "reason": "Reason text for an unconfirmed baseline or abandonment",
  "reconfigure": "Replace an existing config during init",
  "refines-candidate": "Parent Candidate ID for a refinement DevRun",
  "external-directory": "Attach an existing canonical Git root; never delete it on cleanup",
  "input-digest": "Explicitly accept the current input digest from devrun inspect-workspace",
  "directory": "Existing Git workspace directory",
  "remote": "Remote name or URL identifying the repository",
  "remote-url": "Remote URL for repository aliasing",
  "repository": "Repository ID (positional or --repository)",
  "requirement": "Requirement ID (positional or --requirement)",
  "status": "issue list: filter by board status (ready, exploring, candidates_available, candidate_selected, completed, incomplete)",
  "has-open-devrun": "issue list: true|false — true keeps Issues with an open DevRun, false keeps those without (default: no filter)",
  "sort": "issue list: id (default, Issue ID ascending) or activity (latest ledger activity first, Issue ID breaks ties)",
  "state": "devrun list: filter by DevRun state (open, submitted, abandoned)",
  "standing": "candidate list: filter by Verification standing (unverified, inconclusive, qualified, rejected, disputed)",
  "selected": "candidate list: true|false — true keeps currently selected Candidates, false keeps unselected ones (default: no filter)",
  "verdict": "verification list: filter by overall verdict (qualified, rejected, inconclusive)",
  "skills-path": "Managed skills root to inspect (default ~/.agents/skills)",
  "subject-id": "Ledger filter by subject ID",
  "subject-type": "Ledger filter by subject type",
  "side": "Path side to match for a rename: old or new (default new)",
  "tls": "MySQL/PostgreSQL TLS mode",
  "tls-mode": "MySQL/PostgreSQL TLS mode",
  "username": "MySQL/PostgreSQL username",
  "verifications-cursor": "Opaque page cursor for candidate verifications",
  "issue-version": "Public Issue Version number; expected-version is the Selection concurrency version",
  "version": "Print the installed Grounds CLI version",
  "name": "Human-facing Workspace name",
  "bind-requirement": "Issue open binding: preserve (default) or current",
  "dry-run": "Validate and show the publication plan without writing",
  "discard-changes": "Explicitly allow removal of local changes and ignored files",
  "refresh": "candidate replay-check: fetch the registered remote first; may update remote-tracking refs, FETCH_HEAD and the object database of this clone",
};

// Human description per command family/action.  Options are derived from
// commandOptionKeys so the two can never drift.
const commandDocs: Record<string, string> = {
  ...Object.fromEntries(Object.entries(repositoryImageCommands).map(([action, spec]) => [`code-workspace:${action}`, spec.description])),
  ...Object.fromEntries(Object.entries(environmentControlCommands).map(([action, spec]) => [`code-workspace:${action}`, spec.description])),
  ...Object.fromEntries(Object.entries(codeExecutionCommands).map(([action, spec]) => [`code-workspace:${action}`, spec.description])),
  ...Object.fromEntries(Object.entries(codeCleanupCommands).map(([action, spec]) => [`code-workspace:${action}`, spec.description])),
  "code-workspace:route-prepare": "Prepare one independently identified target route under an instance; retain preparation ownership, without DevRun admission or execution",
  "code-workspace:route-show": "Read the route preparation record; its ID is distinct from the Workspace instance ID",
  "code-workspace:route-bind": "Bind a prepared target route to one preparing DevRun; retain ownership without granting execution",
  "code-workspace:environment-save": "Save a Repo environment version: ID --repository REPO --expected-version N --file JSON {name,image,postgres?:{image}}; fixed local images, no default promotion",
  "code-workspace:environment-show": "Read a complete immutable Repo environment by REVISION_ID; does not prove local readiness",
  "code-workspace:config-save": "Save a versioned repository context configuration; does not start development or change existing instances",
  "code-workspace:config-show": "Read a complete immutable code Workspace configuration version",
  "code-workspace:create": "Create an Issue code Workspace instance from fixed configuration and Issue versions; execution remains disabled",
  "code-workspace:restore": "Create a new instance from a reclaimed instance and its Candidate with --context original; prepare, bind and admit separately",
  "code-workspace:show": "Read a code Workspace instance history; a shared database record does not prove local availability",
  "code-workspace:prepare": "Prepare fixed repository baselines; retries recover the original selection; development execution remains disabled",
  ...Object.fromEntries(Object.entries(repositoryArchiveCommands).map(([action, spec]) => [`repository:${action}`, spec.description])),
  "migrate:patchledger": "Migrate PatchLedger configuration and current-repository local state to Grounds",
  "migrate:data": "Perform or resume the one-time data layout migration; --dry-run previews filesystem moves",
  "trace:": "Locate current code and trace verified Git changes to historical Candidate contracts",
  "integration:observe": "Persist target/source/Selection checks and separate Verification standing; offline is always unknown, --refresh fetches both branches",
  "integration:authorize": "Record an explicit one-time user decision accepting unverified landing; only a solely forward-expired gate is eligible",
  "integration:consume": "Freshly fetch and recheck all bound facts, then consume authorization exactly once; never merges or retries an unknown merge outcome",
  "integration:landing": "Persist trusted landing identity, actual target predecessor evidence, Git parent checks and Verification standing; never infers adoption from similar trees",
  "integration:show": "Read an immutable gate, authorization, consumption or landing record",
  "delivery-link:record": "Record a verified Candidate/commit association; requires a full commit OID and expected version",
  "delivery-link:withdraw": "Withdraw LINK_ID at an expected version, retaining immutable history",
  "delivery-link:show": "Read LINK_ID, optionally at a historical --version",
  "init:": "Initialize a Grounds ledger and write its config file",
  "doctor:": "Check PATH CLI, registry release, and managed skill versions",
  "review:": "Explain a Candidate from code location back to its historical contract, claims, and verification",
  "install:skill": "Install the bundled Grounds skills into a directory (default ~/.agents/skills)",
  "config:set-development-mode": "Save the default for new DevRuns with --development-mode simple|container",
  "workspace:bind": "Bind an unpublished draft to --remote-url with --expected-version",
  "config:show": "Show the resolved configuration",
  "config:path": "Print the config file path",
  "config:validate": "Validate the config file",
  "db:status": "Inspect database integrity and metadata",
  "db:test": "Test the database connection",
  "db:migrate": "Apply pending schema migrations",
  "contract:render": "Open a unified reading/editing session: --workspace NAME; add --output DIRECTORY for a static export. Fixed --requirement ID@VERSION and/or repeated --issue ID@VERSION require --output; --format html|markdown (default html)",
  "workspace:read": "Read local JSON draft and optimistic version without database access",
  "workspace:save": "Save --file JSON draft with --expected-version digest; no publication",
  "workspace:edit": "Compatibility alias for contract render --workspace NAME; same unified reading/editing session; stop with Ctrl-C",
  "workspace:migrate": "Explicitly convert Markdown to JSON; --dry-run previews backup; stop old editors first",
  "workspace:resolve": "Save explicitly resolved draft and clear rebase conflicts with --file and --expected-version",
  "workspace:abandon-publication": "Recover committed publication or abandon a proven terminal failure",
  "workspace:new": "Create a local contract draft under the configured ledger identity; no Git or live database required; --format markdown retains legacy authoring",
  "workspace:open": "Open a Requirement or Issue into JSON (default); --format markdown retains legacy authoring",
  "workspace:list": "List local contract drafts for the configured ledger identity",
  "workspace:show": "Show contract draft state and managed resources",
  "workspace:publish": "Publish saved JSON with --expected-version; validate optional Issue target_branch; legacy Markdown remains supported",
  "workspace:rebase": "Three-way merge a stale contract draft with authoritative ledger content",
  "workspace:remove": "Remove a disposable local contract draft",
  "repository:register": "Register the current clone's remote as a Repository",
  "repository:resolve": "Resolve the current clone to a registered Repository",
  "repository:list": "List registered Repositories",
  "repository:show": "Show a Repository and its aliases",
  "repository:move": "Move a Repository to a new canonical remote",
  "repository:alias-add": "Add an alias remote to a Repository",
  "repository:alias-retire": "Retire an alias remote from a Repository",
  "requirement:list": "List Requirements",
  "requirement:show": "Show a Requirement Version and its Issues",
  "issue:list": "List Issues (optionally for a Requirement)",
  "selection:inspect": "Inspect local delivery preparation and safe next steps",
  "completion:show": "Read exact Issue Version completion and retained history; verification remains independent",
  "completion:record": "Record confirmed external delivery (including historical work without a Candidate); --file grounds.issue-completion-input/v1 requires repository_id, full target_branch ref, landed_commit, adoption_evidence, completed_at, origin and release (released version/channel/evidence or not_applicable reason). References are asserted, not checked. No merge or release is executed. First expected-version is 0; reopen before correcting a completed record.",
  "completion:reopen": "Reopen exact Issue Version with a reason and expected completion version; preserve history and restore derived work status",
  "selection:show": "Show the current delivery choice for an Issue Version",
  "selection:set": "Choose or reselect a Candidate (expected-version 0 for the first choice)",
  "selection:clear": "Clear the current choice while retaining its concurrency version",
  "selection:materialize": "Prepare delivery from the pinned Selection version",
  "issue:show": "Show the current or an explicit historical Issue Version",
  "devrun:sync-status": "Observe target advancement offline by default; --refresh explicitly fetches; list durable sync records",
  "devrun:sync-show": "Read one persisted sync reservation, recovery identity and terminal receipt",
  "devrun:sync": "Explicitly sync a stopped managed route from its root; requires --expected-head and refreshed --target-commit; keeps fixed Workspace context and invalidates admission",
  "devrun:sync-complete": "Complete resolved or recoverable sync; --file supplies a JSON array of path/explanation decisions for every conflict",
  "devrun:sync-abandon": "Save post-sync edits, restore original HEAD/index/raw files, and abandon this sync, not the DevRun",
  "devrun:continue": "Record an explicit parallel or paused author policy for a submitted managed branch round; Verification remains bound to the fixed Candidate",
  "devrun:plan": "Plan a managed development branch and absolute worktree path without creating Git worktree or branch; explicit target and definition commit required",
  "devrun:start": "Start a DevRun with a confirmed --plan; parent refinements reuse their managed route unless --parallel-route; target flow supports --base-commit, refinement starts at its parent Candidate base",
  "devrun:inspect-workspace": "Preview external workspace input and digest without changing it",
  "devrun:context": "Fetch the DevRun context (goals, constraints, baseline)",
  "devrun:abandon": "Abandon an open DevRun",
  "devrun:cleanup": "Remove a terminal managed worktree (records a devrun.worktree_removed event and returns deletion_summary) or detach an external workspace",
  "devrun:list": "List DevRuns",
  "devrun:reconcile": "Read-only view of one DevRun across the ledger, local worktree (including whether an env run holds its route) and delivery directories, with findings and safe next steps",
  "devrun:uncommitted": "List DevRuns of this clone whose local worktree holds uncaptured changes or ignored files that exist only on this machine",
  "devrun:show": "Show a DevRun",
  "preflight:observe": "Record an immutable, bound observation of the declared target for a phase; --refresh explicitly fetches; publish/start bind the Issue scope, definition observes a repository/target",
  "preflight:assess": "Record the author's target-appropriateness judgement for an observation from --file; applicable, revision_required or unknown with a substantive rationale",
  "preflight:show": "Read back one persisted preflight observation or assessment",
  "devrun:prepare": "Create a parent-restoration scene (--issue) or mark an existing open run (--dev-run) as preparing; synchronize separately before admission",
  "devrun:admit": "Bind a valid preflight observation/assessment to this DevRun (after re-observing the target under --refresh); required before the first target-flow development and after every new sync or restore",
  "candidate:submit": "Submit a Candidate using a bound project and fresh GitLab checks, or explicit --archive-policy for protected remote Git archival",
  "candidate:archive": "Explicitly preview or archive an existing Candidate source; preserves the existing Git artifact identity and uses the original operation on retry",
  "candidate:diff": "Show a fixed local Git comparison; target requires --target-commit and --observation-time; no implicit remote access",
  "candidate:archive-status": "Inspect fixed archive receipts and local objects; --refresh explicitly checks the remote source and full object closure",
  "candidate:archive-operation": "Read one fixed archive operation and pending/unknown recovery status",
  "candidate:fetch": "Explicitly fetch the fixed Candidate archive into this clone without changing HEAD, index or active files",
  "candidate:restore": "Restore an archived original commit and history into a new caller-owned directory",
  "candidate:lineage": "Show the fixed business predecessor, successors and original development base",
  "candidate:materialize": "Materialize a Candidate into a worktree; review mode without --path creates a CLI-named review session",
  "candidate:show": "Show a Candidate with claims and verifications",
  "candidate:list": "List Candidates for the current or explicit --issue-version",
  "candidate:compare": "Compare Candidates side by side",
  "candidate:template": "Emit a CandidateSubmission skeleton for a DevRun",
  "candidate:artifact": "Show the protected remote Git source/binding/receipt; historical patch-only Candidates are unsupported; local object availability is reported separately",
  "candidate:replay-check": "Check whether a Candidate can be replayed: artifact integrity, local rebuild and remote reachability of its base commit; read-only unless --refresh",
  "verification:submit": "Submit using either --file plus caller attribution, or --handoff with embedded verifier attribution; --mode ultra requires --handoff and --quality-handoff",
  "verification:context": "Fetch the blind or reconcile verification context (--role quality for the ultra code-quality reviewer)",
  "verification:show": "Show a Verification report",
  "verification:list": "List Verifications for a Candidate",
  "verification:template": "Emit a skeleton from either a Candidate ID (ledger) or --context BLIND_JSON (offline)",
  "verification:handoff": "Sign a fixed VerificationReport or quality review report for ledger-free handoff",
  "verification:independent-digest": "Print the digest of a report's independent (blind) part so it can be fixed before the reconcile phase",
  "verification:run": "Coordinator preparation and observation entry for one verification round: record stages, timings and handoff state; never submits or replaces signature/coverage checks",
  "ledger:list": "List ledger events",
  "ledger:show": "Show a single ledger event",
};

// Keep the command-family view available to both dispatch and `GROUP --help`.
// A group help page is a navigation step, not an empty command: it must tell a
// caller which actions exist before it can sensibly request action-level help.
const actionSets: Record<string, string[]> = {
  "code-workspace": [...Object.keys(repositoryImageCommands), ...Object.keys(environmentControlCommands), ...Object.keys(codeCleanupCommands), ...Object.keys(codeExecutionCommands), "environment-save", "environment-show", "config-save", "config-show", "create", "restore", "show", "prepare", "route-prepare", "route-show", "route-bind"],
  integration: ["observe", "authorize", "consume", "landing", "show"],
  migrate: ["patchledger", "data"],
  "delivery-link": ["record", "withdraw", "show"],
  install: ["skill"], db: ["status", "test", "migrate"],
  contract: ["render"],
  workspace: ["bind", "read", "save", "edit", "migrate", "resolve", "abandon-publication", "new", "open", "list", "show", "publish", "rebase", "remove"],
  repository: [...Object.keys(repositoryArchiveCommands), "register", "resolve", "list", "show", "move", "alias-add", "alias-retire"],
  requirement: ["list", "show"], issue: ["list", "show"],
  devrun: ["plan", "continue", "sync-status", "sync-show", "sync", "sync-complete", "sync-abandon", "inspect-workspace", "start", "context", "abandon", "cleanup", "list", "show", "reconcile", "uncommitted", "prepare", "admit"],
  preflight: ["observe", "assess", "show"],
  completion: ["show", "record", "reopen"],
  selection: ["show", "set", "clear", "materialize", "inspect"],
  candidate: ["diff", "archive", "archive-status", "archive-operation", "fetch", "restore", "lineage", "submit", "materialize", "show", "list", "compare", "template", "artifact", "replay-check"],
  verification: ["submit", "context", "show", "list", "template", "handoff", "independent-digest", "run"], ledger: ["list", "show"],
};
const pagedListCommands = new Set(["repository:list", "requirement:list", "issue:list", "devrun:list", "candidate:list", "verification:list"]);
const repeatableOptionKeys: Record<string, Set<string>> = {
  "repository:archive-check": new Set(["repository"]), "repository:archive-guide": new Set(["repository"]), "repository:archive-template": new Set(["repository"]),
  "contract:render": new Set(["issue"]),
  "devrun:context": new Set(["include-verification"]),
  "candidate:compare": new Set(["candidate", "include-patch", "pairwise"]),
};

const positionalBounds: Record<string, [number, number]> = {
  ...Object.fromEntries(Object.keys(repositoryImageCommands).map(action => [`code-workspace:${action}`, [3, 3] as [number, number]])),
  ...Object.fromEntries(Object.keys(environmentControlCommands).map(action => [`code-workspace:${action}`, [3, 3] as [number, number]])),
  ...Object.fromEntries(Object.entries(codeExecutionCommands).map(([action, spec]) => [`code-workspace:${action}`, [spec.positions, spec.positions] as [number, number]])),
  ...Object.fromEntries(Object.keys(codeCleanupCommands).map(action => [`code-workspace:${action}`, [3, 3] as [number, number]])),
  "code-workspace:route-prepare": [3, 3], "code-workspace:route-show": [3, 3],
  "code-workspace:route-bind": [3, 3],
  "code-workspace:environment-save": [3, 3], "code-workspace:environment-show": [3, 3],
  "code-workspace:config-save": [3, 3], "code-workspace:config-show": [3, 3],
  "code-workspace:create": [2, 2], "code-workspace:show": [3, 3],
  "code-workspace:restore": [3, 3],
  "code-workspace:prepare": [3, 3],
  ...Object.fromEntries(Object.keys(repositoryArchiveCommands).map(action => [`repository:${action}`, [2, 2] as [number, number]])),
  "contract:render": [2, 2],
  "migrate:patchledger": [2, 2],
  "migrate:data": [2, 2],
  "delivery-link:withdraw": [3, 3], "delivery-link:show": [3, 3],
  "integration:observe": [2, 2], "integration:authorize": [2, 2], "integration:consume": [2, 2], "integration:landing": [2, 2], "integration:show": [2, 3],
  "delivery-link:record": [2, 2],
  "trace:": [1, 1],
  "init:": [1, 1],
  "doctor:": [1, 1],
  "review:": [1, 2],
  "install:skill": [2, 3],
  "config:set-development-mode": [2, 2], "workspace:bind": [3, 3],
  "config:show": [2, 2], "config:path": [2, 2], "config:validate": [2, 2],
  "db:status": [2, 2], "db:test": [2, 2], "db:migrate": [2, 2],
  "workspace:read": [3,3], "workspace:save": [3,3], "workspace:edit": [3,3], "workspace:migrate": [3,3], "workspace:resolve": [3,3], "workspace:abandon-publication": [3,3], "workspace:new": [2, 3], "workspace:open": [4, 4], "workspace:list": [2, 2], "workspace:show": [2, 3], "workspace:publish": [2, 3], "workspace:rebase": [2, 3], "workspace:remove": [2, 3],
  "repository:register": [2, 2], "repository:resolve": [2, 2], "repository:list": [2, 2], "repository:show": [2, 3], "repository:move": [2, 3], "repository:alias-add": [2, 3], "repository:alias-retire": [2, 3],
  "requirement:list": [2, 2], "requirement:show": [2, 3],
  "completion:show": [2, 2], "completion:record": [2, 2], "completion:reopen": [2, 2],
  "selection:inspect": [2, 2], "selection:show": [2, 2], "selection:set": [2, 2], "selection:clear": [2, 2], "selection:materialize": [2, 2],
  "issue:list": [2, 2], "issue:show": [2, 3],
  "devrun:sync-status": [2, 3], "devrun:sync-show": [2, 3], "devrun:sync": [2, 3], "devrun:sync-complete": [2, 3], "devrun:sync-abandon": [2, 3],
  "devrun:continue": [2, 2], "devrun:plan": [2, 2], "devrun:inspect-workspace": [2, 3], "devrun:start": [2, 3], "devrun:context": [2, 3], "devrun:abandon": [2, 3], "devrun:cleanup": [2, 3], "devrun:list": [2, 2], "devrun:show": [2, 3], "devrun:reconcile": [2, 3], "devrun:uncommitted": [2, 2], "devrun:prepare": [2, 3], "devrun:admit": [2, 3],
  "preflight:observe": [2, 2], "preflight:assess": [2, 2], "preflight:show": [2, 3],
  "candidate:diff": [2, 3], "candidate:archive": [2, 3], "candidate:archive-status": [2, 3], "candidate:archive-operation": [2, 2], "candidate:fetch": [2, 3], "candidate:restore": [2, 3], "candidate:lineage": [2, 3],
  "candidate:submit": [2, 3], "candidate:materialize": [2, 3], "candidate:show": [2, 3], "candidate:list": [2, 2], "candidate:compare": [2, Number.MAX_SAFE_INTEGER], "candidate:template": [2, 3], "candidate:artifact": [2, 3], "candidate:replay-check": [2, 2],
  "verification:submit": [2, 3], "verification:context": [2, 3], "verification:show": [2, 3], "verification:list": [2, 2], "verification:template": [2, 3], "verification:handoff": [2, 2], "verification:independent-digest": [2, 2],
  "ledger:list": [2, 2], "ledger:show": [2, 3],
};

const validatePositionals = (args: ParsedArgs, group: string, action: string): void => {
  const bounds = positionalBounds[`${group}:${action}`];
  if (!bounds) return;
  const [minimum, maximum] = bounds;
  if (args.positionals.length < minimum || args.positionals.length > maximum) throw validation("command", `${group} ${action} expects ${minimum === maximum ? minimum : `between ${minimum} and ${maximum}`} positional arguments`);
};

const validateCommandArguments = (args: ParsedArgs, group: string, action: string): void => {
  validateOptionKeys(args);
  const repeatable = repeatableOptionKeys[`${group}:${action}`] ?? new Set<string>();
  for (const [key, raw] of Object.entries(args.values)) if (Array.isArray(raw) && !repeatable.has(key)) throw validation(`--${key}`, "must be supplied at most once");
  const configured = commandOptionKeys[`${group}:${action}`] ?? commandOptionKeys[`${group}:`];
  if (configured) {
    // This process-local selector does not alter the persisted command contract.
    const allowed = new Set(configured).add("cwd");
    for (const key of Object.keys(args.values)) if (!allowed.has(key) && key !== "json") throw validation(`--${key}`, `is not valid for ${group}${action ? ` ${action}` : ""}`);
  }
  for (const [key, optionValue] of Object.entries(args.values)) {
    if (optionValue === true && !booleanOptionKeys.has(key)) throw validation(key, "requires a value");
    if (booleanOptionKeys.has(key)) {
      const entries = Array.isArray(optionValue) ? optionValue : [optionValue];
      for (const entry of entries) {
        if (entry !== true && typeof entry !== "string") throw validation(key, "must be boolean");
        if (typeof entry === "string" && entry.toLowerCase() !== "true" && entry.toLowerCase() !== "false") throw validation(key, "must be boolean");
      }
    }
  }
  validatePositionals(args, group, action);
};

const validateHelpArguments = (args: ParsedArgs): void => {
  // Help is intentionally available as a global escape hatch, including on
  // subcommands (for example `requirement list --help`).  It must not,
  // however, become a way to smuggle arbitrary/typoed options past the
  // command parser.  Keep the accepted surface deliberately tiny and apply
  // the same boolean grammar as normal command validation.
  validateOptionKeys(args);
  for (const [key, raw] of Object.entries(args.values)) {
    if (key !== "help" && key !== "json") throw validation(`--${key}`, "is not valid for help");
    const entries = Array.isArray(raw) ? raw : [raw];
    for (const entry of entries) {
      if (entry !== true && typeof entry !== "string") throw validation(key, "must be boolean");
      if (typeof entry === "string" && entry.toLowerCase() !== "true" && entry.toLowerCase() !== "false") throw validation(key, "must be boolean");
    }
  }
  // The standalone form may take one topic.  When `--help` is attached to a
  // command, its normal positional arguments are intentionally ignored so a
  // user can ask for help before supplying required IDs/files.
  if ((args.positionals.length > 0 && args.positionals[0] === "help") && args.positionals.length > 2) throw validation("command", "help expects at most one topic");
};

// Render the per-command option list.  The set comes from commandOptionKeys
// (the same allow-list the validator uses), so the help text can never show an
// option the parser would reject, or hide one it accepts.
const commandHelp = (group: string, action: string): { command: string; description: string; actions: string[]; options: { name: string; description: string }[] } => {
  const key = `${group}:${action === "" ? "" : action}`;
  const fallbackKey = `${group}:`;
  const docs = commandDocs[key] ?? commandDocs[fallbackKey] ?? "";
  const configured = commandOptionKeys[key] ?? commandOptionKeys[fallbackKey] ?? new Set<string>();
  const options = [...new Set(configured).add("cwd")].sort().map((name) => ({ name, description: optionDocs[name] ?? "" }));
  const command = group === "review" && !action ? "review [candidate-id]" : `${group === "workspace" ? "draft" : group}${action ? ` ${action}` : ""}`;
  return { command, description: docs, actions: action ? [] : (actionSets[group] ?? []), options };
};

const formatCommandHelp = (help: { command: string; description: string; actions: string[]; options: { name: string; description: string }[] }): string => {
  const lines = [`grounds ${help.command}`, ""];
  if (help.description) lines.push(help.description, "");
  if (help.actions.length) {
    lines.push("可用操作:");
    for (const action of help.actions) {
      const invocation = `${help.command} ${action}`;
      lines.push(`  ${invocation.padEnd(28)} ${commandDocs[`${help.command === "draft" ? "workspace" : help.command}:${action}`] ?? ""}`);
    }
    lines.push("", `继续查看: grounds ${help.command} <操作> --help`);
  }
  if (help.options.length) {
    lines.push("选项:");
    for (const option of help.options) lines.push(`  --${option.name.padEnd(28)} ${option.description}`);
    lines.push("", "通用: --config PATH, --cwd DIR, --json (任意命令可用)");
  } else if (!help.actions.length) {
    lines.push("无参数选项。");
  }
  return lines.join("\n");
};

const commaSeparated = (args: ParsedArgs, key: string): string[] => {
  const raw = values(args, key);
  if (raw.length === 0) return [];
  const result = raw.flatMap((value) => value.split(",").map((item) => item.trim()));
  if (result.some((item) => !item)) throw validation(key, "must not contain an empty item");
  return result;
};

const value = (args: ParsedArgs, key: string, fallback = ""): string => { const v = args.values[key]; if (v === undefined) return fallback; if (Array.isArray(v)) return String(v[v.length - 1]); return String(v); };
const hasOption = (args: ParsedArgs, key: string): boolean => args.values[key] !== undefined;
const optionalBoolean = (args: ParsedArgs, key: string): boolean | undefined => {
  if (!hasOption(args, key)) return undefined;
  const raw = value(args, key).toLowerCase();
  if (raw !== "true" && raw !== "false") throw validation(key, "must be true or false");
  return raw === "true";
};
// Paged mode is explicit: `--limit` and/or `--cursor` switch a resource list to
// cursor pages; without them the published complete-list behaviour is kept.
const pageRequest = (args: ParsedArgs): { limit?: number; cursor?: string } | undefined => {
  if (!hasOption(args, "limit") && !hasOption(args, "cursor")) return undefined;
  return { ...(hasOption(args, "limit") ? { limit: integerValue(args, "limit", 1) } : {}), ...(hasOption(args, "cursor") ? { cursor: required(args, "cursor") } : {}) };
};
const bool = (args: ParsedArgs, key: string): boolean => args.values[key] === true || value(args, key).toLowerCase() === "true";
// Once a caller includes --json, keep failures in the machine-readable
// envelope even when the value itself is malformed.  The command validator
// still reports the invalid boolean; treating its presence as a request for
// JSON prevents a typo from switching the output protocol to human text.
const jsonOutputRequested = (args: ParsedArgs): boolean => {
  if (!hasOption(args, "json")) return false;
  const raw = args.values.json;
  const last = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  return last !== false && !(typeof last === "string" && last.toLowerCase() === "false");
};
const values = (args: ParsedArgs, key: string): string[] => { const v = args.values[key]; if (v === undefined) return []; return Array.isArray(v) ? v.map(String) : [String(v)]; };
const required = (args: ParsedArgs, key: string): string => { const v = value(args, key); if (!v) throw validation(key, "is required"); return v; };
// Resource IDs are documented as positional arguments, but the handlers have
// historically accepted named forms as well.  Resolve both forms in one
// place and reject an ambiguous invocation instead of silently preferring the
// positional value and ignoring the flag.
const resourceID = (args: ParsedArgs, optionKey: string, field: string): string => {
  const hasPositional = args.positionals[2] !== undefined;
  const hasOptionValue = hasOption(args, optionKey);
  if (hasPositional && hasOptionValue) throw validation(field, `use either positional ${field} or --${optionKey}, not both`);
  const result = hasPositional ? args.positionals[2] : hasOptionValue ? value(args, optionKey) : "";
  if (!result) throw validation(field, "is required");
  return result;
};
const reviewLocation = (args: ParsedArgs): ReviewLocationRequest | undefined => {
  const raw = value(args, "at");
  if (!raw) {
    if (hasOption(args, "at")) throw validation("at", "must not be empty");
    if (hasOption(args, "side")) throw validation("side", "requires --at");
    return undefined;
  }
  if ([...raw].length > 4112 || raw.includes("\0")) throw validation("at", "must contain a path of at most 4096 characters");
  const side = value(args, "side", "new");
  if (side !== "old" && side !== "new") throw validation("side", "must be old or new");
  const match = raw.match(/^(.*):([1-9][0-9]*)$/);
  const path = match ? match[1] : raw;
  const line = match ? parseInteger(match[2], "at.line", 1) : undefined;
  if (!path || [...path].length > 4096) throw validation("at", "must contain a non-empty path of at most 4096 characters");
  return { path, side, ...(line === undefined ? {} : { line }) };
};
const parseInteger = (raw: string, field: string, minimum?: number): number => {
  if (!/^[+-]?\d+$/.test(raw)) throw validation(field, "must be an integer");
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || (minimum !== undefined && parsed < minimum)) throw validation(field, minimum === undefined ? "must be a safe integer" : `must be at least ${minimum}`);
  return parsed;
};
/**
 * Where verification material goes: an explicit --out file, or the named file inside an existing
 * review session. With neither option nothing is written, so existing callers keep stdout-only behavior.
 */
const materialOutput = (args: ParsedArgs, cwd: string, pick: (sessions: ReviewSessions, sessionID: string) => string): string | undefined => {
  const explicit = hasOption(args, "out"), session = hasOption(args, "review-session");
  if (explicit && session) throw validation("out", "cannot be combined with --review-session");
  if (explicit) { const target = value(args, "out"); if (!target.trim()) throw validation("out", "must not be empty"); return resolve(target); }
  if (!session) return undefined;
  const id = value(args, "review-session");
  if (!id.trim()) throw validation("review_session", "must not be empty");
  return pick(new ReviewSessions(commonRepositoryRoot(cwd)), id);
};
const reportRole = (format: string): ReviewRole => (format === QUALITY_REPORT_FORMAT ? "quality" : "contract");
const integerValue = (args: ParsedArgs, key: string, minimum?: number, fallback?: string): number => {
  const raw = value(args, key, fallback);
  if (!raw && fallback === undefined) throw validation(key, "is required");
  return parseInteger(raw, key, minimum);
};
const operationID = (args: ParsedArgs, io: CLIIO): string => {
  const supplied = value(args, "operation-id");
  if (hasOption(args, "operation-id")) {
    if (!supplied || !isUUIDv7(supplied)) throw validation("operation_id", "must be a lowercase UUIDv7");
    return supplied;
  }
  const id = newUUIDv7();
  stderr(io, `operation_id: ${id}`);
  return id;
};

const readBoundedFile = (filePath: string, maxBytes: number, field: string): Buffer => {
  let fd: number | undefined;
  try {
    // Keep the file option contract consistent with YAML inputs: `-` means
    // stdin, while all other paths are opened normally.  Never close fd 0;
    // callers may still need stdin for a subsequent prompt/read.
    fd = filePath === "-" ? 0 : openSync(filePath, "r");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, maxBytes + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      chunks.push(chunk.subarray(0, count));
      if (total > maxBytes) throw validation(field, `must not exceed ${maxBytes} bytes`);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw validation(field, error instanceof Error ? error.message : String(error));
  } finally {
    if (fd !== undefined && fd !== 0) closeSync(fd);
  }
};

const defaultPrompt = async (question: string): Promise<string> => {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try { return await terminal.question(question); } finally { terminal.close(); }
};

const canPrompt = (args: ParsedArgs, io: CLIIO): boolean =>
  !bool(args, "json") && !bool(args, "non-interactive") && (io.isTTY ?? Boolean(process.stdin.isTTY && process.stderr.isTTY));

const promptValue = async (args: ParsedArgs, io: CLIIO, key: string, question: string, fallback = ""): Promise<string> => {
  if (args.values[key] !== undefined) return value(args, key);
  if (!canPrompt(args, io)) return fallback;
  const answer = (await (io.prompt ?? defaultPrompt)(question)).trim();
  return answer || fallback;
};

const selectDevelopmentMode = async (args: ParsedArgs, io: CLIIO, config: Config): Promise<DevelopmentModeSelection> => {
  const selected = resolveDevelopmentMode({
    ...(hasOption(args, "development-mode") ? { argument: value(args, "development-mode") } : {}),
    environment: process.env.GROUNDS_DEVELOPMENT_MODE,
    configuration: config.development?.default_mode,
  });
  if (selected) return selected;
  if (!canPrompt(args, io)) throw validation("development-mode", "select --development-mode simple|container, GROUNDS_DEVELOPMENT_MODE, or config development.default_mode before starting a DevRun");
  const answer = await (io.prompt ?? defaultPrompt)("Development mode [simple/container]: ");
  return { mode: validateDevelopmentMode(answer.trim()), source: "interactive" };
};

const gitIdentity = (cwd: string): Attribution => {
  const read = (name: string): string => { try { return execFileSync("git", ["config", "--get", name], { cwd, encoding: "utf8" }).trim(); } catch { return ""; } };
  const gitName = read("user.name"); const gitEmail = read("user.email");
  if (!gitName || !gitEmail) throw validation("attribution", "Git user.name and user.email are required for human commands");
  return { kind: "human", git_name: gitName, git_email: gitEmail };
};

const attribution = (args: ParsedArgs, cwd: string): Attribution => {
  const hasAgentID = hasOption(args, "agent-id"); const hasAgentName = hasOption(args, "agent-name");
  const agentID = value(args, "agent-id"); const agentName = value(args, "agent-name", agentID);
  if (hasAgentID || hasAgentName) { if (!agentID || !agentName) throw validation("attribution", "--agent-id and --agent-name must be supplied together and must not be empty"); return { kind: "agent", agent_id: agentID, display_name: agentName }; }
  return gitIdentity(cwd);
};

const storeForConfig = (config: Config): SQLStore => {
  if (config.database.driver === "sqlite") return SQLStore.sqlite(config.database.path!);
  if (config.database.tls?.ca_file) {
    try { readFileSync(config.database.tls.ca_file); } catch { throw validation("database.tls.ca_file", "file does not exist or cannot be read"); }
  }
  const connection = { host: config.database.host!, port: config.database.port!, database: config.database.database!, username: config.database.username!, password: networkPassword(config.database), caFile: config.database.tls?.ca_file };
  return config.database.driver === "postgres" ? SQLStore.postgres(connection) : SQLStore.mysql(connection);
};

const normalizedConfigHost = (host: string | undefined): string => (host ?? "").replace(/^\[|\]$/g, "").toLowerCase();

const sameDatabaseTarget = (left: DatabaseConfig, right: DatabaseConfig): boolean => {
  if (left.driver !== right.driver) return false;
  if (left.driver === "sqlite") return left.path === right.path;
  return normalizedConfigHost(left.host) === normalizedConfigHost(right.host)
    && left.port === right.port
    && left.database === right.database
    && left.username === right.username
    && left.tls?.mode === right.tls?.mode
    && left.tls?.ca_file === right.tls?.ca_file
    && left.password?.source === right.password?.source
    && left.password?.variable === right.password?.variable;
};

const databaseIdentityMismatch = (): DomainError => new DomainError(
  "DATABASE_ID_MISMATCH",
  "config points at a different database",
  false,
  { reason: "expected_database_id does not match" },
);

const openStore = async (pathOverride = ""): Promise<{ store: SQLStore; config: Config; policy: "warn" | "require_override" }> => {
  const path = configPath(pathOverride);
  if (!pathOverride && !existsSync(path) && existsSync(legacyConfigPath())) {
    throw new DomainError("BRAND_MIGRATION_REQUIRED", "legacy PatchLedger configuration must be migrated to Grounds", false, {
      reason: `legacy configuration exists at ${legacyConfigPath()}`,
      migrate_argv: ["grounds", "migrate", "patchledger"],
    });
  }
  if (!existsSync(path)) throw new DomainError("SCHEMA_INCOMPATIBLE", `configuration file does not exist: ${path}`, false, schemaDetails(SCHEMA_VERSION, `configuration file does not exist: ${path}`));
  const config = loadConfig(path); const store = storeForConfig(config);
  try {
    const metadata = await store.open();
    if (metadata.database_id !== config.database.expected_database_id) throw databaseIdentityMismatch();
    return { store, config, policy: metadata.baseline_reachability_policy };
  } catch (error) {
    try { await store.close(); } catch { /* preserve the original open/identity error */ }
    throw error;
  }
};

const initCommand = async (args: ParsedArgs, io: CLIIO, observedAbsent = false): Promise<unknown> => {
  const configFile = configPath(value(args, "config"));
  if (existsSync(configFile) && !bool(args, "reconfigure") && !observedAbsent) throw validation("config", "already exists; pass --reconfigure to replace it");
  const driver = await promptValue(args, io, "driver", "Storage driver [sqlite/mysql/postgres] (sqlite): ", "sqlite") as "sqlite" | "mysql" | "postgres";
  if (driver !== "sqlite" && driver !== "mysql" && driver !== "postgres") throw validation("driver", "must be sqlite, mysql or postgres");
  const policy = await promptValue(args, io, "baseline-policy", `Baseline policy [warn/require_override] (${driver === "sqlite" ? "warn" : "require_override"}): `, driver === "sqlite" ? "warn" : "require_override") as "warn" | "require_override";
  if (policy !== "warn" && policy !== "require_override") throw validation("baseline-policy", "must be warn or require_override");
  let db: DatabaseConfig;
  if (driver === "sqlite") {
    const configuredPath = await promptValue(args, io, "path", `SQLite database path (${defaultSQLitePath()}): `, defaultSQLitePath());
    db = { driver, path: resolve(configuredPath), expected_database_id: newUUIDv7() };
  } else {
    if (!canPrompt(args, io)) {
      for (const key of ["host", "database", "username"]) if (args.values[key] === undefined) throw validation(key, `is required for non-interactive ${driver === "postgres" ? "PostgreSQL" : "MySQL"} initialization`);
    }
    const engine = driver === "postgres" ? "PostgreSQL" : "MySQL";
    const defaultPort = driver === "postgres" ? "5432" : "3306";
    const host = await promptValue(args, io, "host", `${engine} host: `);
    const port = await promptValue(args, io, "port", `${engine} port (${defaultPort}): `, defaultPort);
    const database = await promptValue(args, io, "database", `${engine} database: `);
    const username = await promptValue(args, io, "username", `${engine} username: `);
    const tlsFlag = args.values["tls-mode"] === undefined ? "tls" : "tls-mode";
    if (args.values.tls !== undefined && args.values["tls-mode"] !== undefined && value(args, "tls") !== value(args, "tls-mode")) throw validation("tls-mode", "use either --tls-mode or --tls, not both");
    const tlsMode = await promptValue(args, io, tlsFlag, "TLS mode (verify_identity): ", "verify_identity");
    const caFile = await promptValue(args, io, "ca-file", "CA file (leave empty for system trust): ");
    const passwordSource = await promptValue(args, io, "password-source", "Password source [keychain/environment] (environment): ", "environment") as "environment" | "keychain";
    if (!host) throw validation("host", "is required");
    if (!database) throw validation("database", "is required");
    if (!username) throw validation("username", "is required");
    if (tlsMode !== "verify_identity") throw validation("tls", "must equal verify_identity");
    if (passwordSource !== "environment" && passwordSource !== "keychain") throw validation("password-source", "must be keychain or environment");
    db = { driver, host, port: parseInteger(port, "port", 1), database, username, tls: { mode: "verify_identity", ...(caFile ? { ca_file: caFile } : {}) }, password: passwordSource === "environment" ? { source: "environment", variable: driver === "postgres" ? "GROUNDS_POSTGRES_PASSWORD" : "GROUNDS_MYSQL_PASSWORD" } : { source: "keychain" }, expected_database_id: newUUIDv7() };
  }
  const config: Config = { version: 2, database: db };
  // Validate the complete connection model before constructing a pool or
  // touching the target database.  This keeps malformed init flags in the
  // stable VALIDATION_ERROR path and prevents a partially initialized target.
  validateConfig(config);
  const store = storeForConfig(config);
  let initialized;
  try {
    const target = await store.classifyTarget();
    if (target.state === "unrecognized") throw new DomainError("SCHEMA_INCOMPATIBLE", "database is neither empty nor an initialized Grounds database", false, schemaDetails(SCHEMA_VERSION, "unrecognized tables"));
    if (driver !== "sqlite" && target.state === "empty" && !bool(args, "confirm-initialize")) {
      const confirmed = await promptValue(args, io, "confirm-initialize", `Initialize empty ${driver === "postgres" ? "PostgreSQL" : "MySQL"} database ${db.database} on ${db.host}? Type yes: `);
      if (confirmed.toLowerCase() !== "yes") throw validation("confirm-initialize", `explicit confirmation is required for an empty ${driver === "postgres" ? "PostgreSQL" : "MySQL"} database`);
    }
    initialized = await store.initialize(policy);
  } finally {
    await store.close();
  }
  db.expected_database_id = initialized.metadata.database_id;
  config.database.expected_database_id = initialized.metadata.database_id;
  const result = { result_type: "patchledger.result.init/v1", command: "init", config_path: configFile, database_id: initialized.metadata.database_id, database_action: initialized.action, driver };
  const { writeConfig } = await import("./config.js");
  try {
    writeConfig(configFile, config, bool(args, "reconfigure"));
  } catch (error) {
    // Two full CLI initializers can both pass the early exists check. If the
    // other initializer atomically published the same database target, its
    // config is the durable winner and this invocation should attach to it.
    // Never accept an unrelated or malformed config in this recovery path.
    if (!bool(args, "reconfigure") && error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "config" && error.details.reason === "already exists; pass --reconfigure to replace it") {
      try {
        const existing = loadConfig(configFile);
        if (existing.database.expected_database_id === config.database.expected_database_id && sameDatabaseTarget(existing.database, config.database)) return result;
      } catch { /* preserve the original no-clobber publication error */ }
    }
    throw error;
  }
  return result;
};

const plainShortOID = (qualified: string): string => {
  const plain = qualified.includes(":") ? qualified.slice(qualified.indexOf(":") + 1) : qualified;
  return plain.length > 12 ? plain.slice(0, 12) : plain;
};

const baselineForRemoteNames = (args: ParsedArgs, cwd: string, names: string[], policy: "warn" | "require_override"): Baseline => {
  if (hasOption(args, "baseline") && !value(args, "baseline")) throw validation("baseline", "must not be empty");
  const issueBaseline = value(args, "baseline", "HEAD"); const oid = resolveBaseline(cwd, issueBaseline);
  const reachable = remoteTrackingReachable(cwd, oid, names);
  const allowUnpublished = bool(args, "allow-unpublished-baseline");
  const hasLegacyReason = hasOption(args, "override-reason");
  const hasReason = hasOption(args, "reason");
  const legacyReason = value(args, "override-reason");
  const reason = value(args, "reason");
  if (hasLegacyReason && hasReason && legacyReason !== reason) throw validation("reason", "use either --reason or --override-reason, not both");
  const overrideReason = hasReason ? reason : hasLegacyReason ? legacyReason : undefined;
  if (reachable) {
    if (allowUnpublished || overrideReason !== undefined) throw validation("baseline", "--allow-unpublished-baseline and --reason are only valid for an unconfirmed baseline");
    return { git_oid: oid, reachability: "remote_tracking_reachable" };
  }
  const shortOID = plainShortOID(oid);
  const matchingRefs = names.length > 0 ? names.map((name) => `refs/remotes/${name}`).join(", ") : "none";
  const diagnostic = `baseline ${shortOID} exists locally but is not reachable from a matching remote-tracking ref (checked: ${matchingRefs}); it may be an unpublished local commit — fetch/push the branch to publish it. This does not block a local DevRun, but an off-machine rebuild cannot fetch the baseline`;
  if (policy === "require_override" && (!allowUnpublished || !overrideReason?.trim())) throw new DomainError("BASELINE_UNAVAILABLE", "baseline is not reachable from a matching remote-tracking ref; pass --allow-unpublished-baseline --reason <text> if policy permits an explicit override");
  if (!allowUnpublished && overrideReason !== undefined) throw validation("reason", "requires --allow-unpublished-baseline");
  if (allowUnpublished && !overrideReason?.trim()) throw validation("reason", "is required with --allow-unpublished-baseline");
  return { git_oid: oid, reachability: "unconfirmed", warning: diagnostic, ...(allowUnpublished ? { override_reason: overrideReason!.trim() } : {}) };
};

const baselineFor = async (module: Module, args: ParsedArgs, cwd: string, repositoryID: string, policy: "warn" | "require_override"): Promise<Baseline> => {
  const remotes = await module.activeRepositoryRemotes(repositoryID); const local = discoverRepository(cwd); const names = matchingRemoteNames(local, remotes);
  if (names.length === 0) throw worktreeMismatch(repositoryID, "current clone does not match the Issue Repository");
  return baselineForRemoteNames(args, cwd, names, policy);
};

const explorationBriefFor = (args: ParsedArgs): string | undefined => {
  const hasBrief = hasOption(args, "brief"); const hasCompatibilityBrief = hasOption(args, "exploration-brief"); const hasBriefFile = hasOption(args, "brief-file");
  const brief = value(args, "brief"); const compatibilityBrief = value(args, "exploration-brief"); const briefFile = value(args, "brief-file");
  if (hasBrief && hasCompatibilityBrief) throw validation("brief", "use either --brief or --exploration-brief, not both");
  const hasInline = hasBrief || hasCompatibilityBrief;
  const inline = hasBrief ? brief : compatibilityBrief;
  if (hasInline && hasBriefFile) throw validation("brief-file", "cannot be combined with an inline brief");
  // `value()` intentionally returns an empty string for an omitted option.
  // Do not treat that fallback as a supplied (but empty) brief: absence means
  // the field should be omitted from the DevRun, while an explicit
  // `--brief=` is rejected below.
  let result: string | undefined = hasInline ? inline : undefined;
  if (hasBriefFile) {
    if (!briefFile) throw validation("brief-file", "must not be empty");
    let bytes: Buffer;
    bytes = readBoundedFile(briefFile, 65536, "brief-file");
    result = bytes.toString("utf8");
    if (!Buffer.from(result, "utf8").equals(bytes)) throw validation("brief-file", "must contain valid UTF-8 text");
  }
  if (result === undefined) return undefined;
  validateOptionalLongText(hasBriefFile ? "brief-file" : "brief", result);
  return result;
};

const resolveCurrentRepository = async (module: Module, args: ParsedArgs, cwd: string): Promise<{ id: string; canonical: string }> => {
  const hasRemote = hasOption(args, "remote");
  const hasRepository = hasOption(args, "repository");
  const remoteName = value(args, "remote");
  const repositoryID = value(args, "repository");
  if (hasRemote && !remoteName) throw validation("remote", "must not be empty");
  if (hasRepository && !repositoryID) throw validation("repository", "must not be empty");
  if (hasRemote && hasRepository) throw validation("repository", "use either --repository or --remote, not both");
  const local = discoverRepository(cwd); const selected = remoteName ? selectRemote(local, remoteName) : undefined;
  if (repositoryID) { const detail = await module.showRepository(repositoryID); await validateRepositoryClone(module, cwd, detail.repository_id); return { id: detail.repository_id, canonical: detail.canonical_remote }; }
  const remotes = selected ? [selected.canonical] : local.remotes.map((remote) => remote.canonical); const repository = await module.resolveRepository(remotes); return { id: repository.id, canonical: repository.canonical_remote };
};

const validateRepositoryClone = async (module: Module, path: string, repositoryId: string): Promise<void> => {
  const local = discoverRepository(path);
  const registered = await module.activeRepositoryRemotes(repositoryId);
  if (matchingRemoteNames(local, registered).length === 0) throw worktreeMismatch(repositoryId, "selected clone does not match the Repository");
};

const validateMaterializationTarget = async (module: Module, path: string, repositoryId: string, baselineOID: string): Promise<void> => {
  await validateRepositoryClone(module, path, repositoryId);
  if (resolveBaseline(path, "HEAD") !== baselineOID) throw worktreeMismatch(repositoryId, "current HEAD does not equal the Candidate baseline");
};

const configCommand = (args: ParsedArgs): unknown => {
  const path = configPath(value(args, "config"));
  const action = args.positionals[1] ?? "";
  if (!action) throw validation("config", "expected show, path, validate, or set-development-mode");
  if (action === "path") return { result_type: "patchledger.result.config-path/v1", command: "config.path", config_path: path };
  const config = loadConfig(path);
  if (action === "set-development-mode") {
    config.development = { default_mode: validateDevelopmentMode(required(args, "development-mode")) };
    writeConfig(path, config, true);
    return { result_type: "grounds.result.development-default/v1", command: "config.set-development-mode", mode: config.development.default_mode };
  }
  if (action === "show") return { result_type: "patchledger.result.config-show/v1", command: "config.show", config };
  if (action === "validate") return { result_type: "patchledger.result.config-validate/v1", command: "config.validate", valid: true };
  throw validation("command", `unknown config action: ${action}`);
};

const databaseResult = (command: "db.test" | "db.status" | "db.migrate", metadata: Metadata, integrity?: IntegrityReport): unknown => ({
  result_type: "patchledger.result.database/v1",
  command,
  database_id: metadata.database_id,
  schema_version: metadata.schema_version,
  protocol_version: metadata.protocol_version,
  remote_normalization_version: metadata.remote_normalization_version,
  baseline_reachability_policy: metadata.baseline_reachability_policy,
  migration_state: metadata.migration_state,
  ...(integrity === undefined ? {} : { integrity }),
});

const routeLeased = (cwd: string, databaseID: string, runID: string): boolean => {
  const view = new DevWorktreeModule(cwd, databaseID, newUUIDv7).observe(runID).view;
  return view.status === "available" && isRouteLeased(view.path);
};

export const execute = async (argv: string[], io: CLIIO = {}): Promise<unknown> => {
  const args = parseArgs(argv), group = args.positionals[0] ?? "", action = args.positionals[1] ?? "";
  // Preserve the concurrent-init publication protocol across asynchronous lock acquisition.
  const initObservedAbsent = group === "init" && !existsSync(configPath(value(args, "config")));
  const informational = bool(args, "help") || action === "help" || ["help", "--help", "version", "-v", "doctor", "install", "migrate"].includes(group)
    || (hasOption(args, "version") && args.positionals.length === 0) || (group === "config" && action === "path");
  if (informational) return executeCommand(argv, io);
  return withRuntimeLock(directoryRegistryRoot(), "data-layout", async () => {
    requireCurrentDataLayout(value(args, "cwd", io.cwd ?? process.cwd()));
    return executeCommand(argv, io, initObservedAbsent);
  }, 0, "shared");
};

const executeCommand = async (argv: string[], io: CLIIO = {}, initObservedAbsent = false): Promise<unknown> => {
  const args = parseArgs(argv); const group = args.positionals[0] ?? ""; const action = args.positionals[1] ?? ""; const cwd = value(args, "cwd", io.cwd ?? process.cwd());
  if (group === "env") return executeEnvironmentCommand(args, cwd, {
    resolveRepository: async (workspace: string, devRunId?: string) => {
      requireNoLegacyBrandState(workspace, value(args, "config"));
      const opened = await openStore(value(args, "config"));
      opened.store.setGitArtifactResolver(ref => {
        if (!ref.git_artifact) throw validation("artifact", "Git artifact metadata required");
        return deriveLocalGitArtifact(workspace, ref.git_artifact.binding);
      });
      try {
        const coordinator = new PreflightService(opened.store, cwd).coordinator({ refresh: false });
        const module = new Module(opened.store, newUUIDv7, undefined, undefined, coordinator);
        const repository = await resolveCurrentRepository(module, args, workspace);
        if (!devRunId) {
          if (isRouteWorkspace(workspace)) throw validation("dev-run", "managed route requires its explicit DevRun identity before execution");
          return { taskRepositoryId: repository.id, resolvedRepositoryId: repository.id };
        }
        const result = await module.devRunContext(devRunId, false, []);
        const context = result.context;
        if (context.repository.id !== repository.id) throw validation("repository", "DevRun and environment workspace resolve to different Repositories");
        const local = new DevWorktreeModule(cwd, opened.config.database.expected_database_id, newUUIDv7, opened.store).inspect(devRunId);
        if (local.status !== "available" || resolve(local.path) !== resolve(workspace)) throw validation("workspace", "workspace does not match the selected DevRun");
        await module.assertDevelopmentAdmission(devRunId);
        return { ...(context.dev_run.execution_mode ? { executionMode: context.dev_run.execution_mode.mode } : {}), taskRepositoryId: context.repository.id, resolvedRepositoryId: repository.id, devRunId,
          inputCommit: resolveBaseline(workspace, "HEAD"), ...(context.dev_run.development ? { branch: context.dev_run.development.branch } : {}) };
      } finally { await opened.store.close(); }
    },
  });

  if (isVerificationRunCommand(args)) {
    if (bool(args, "help") || verificationRunSubcommand(args) === "help") return { result_type: "patchledger.result.help/v1", command: "help", usage: verificationRunHelp() };
    validateVerificationRunArgs(args);
    requireNoLegacyBrandState(cwd, value(args, "config"));
    // Only creation accepts attribution. Later observations use the recorded
    // run identity and read commands must work without a human Git profile.
    if (verificationRunSubcommand(args) === "start") attribution(args, cwd);
    const opened = await openStore(value(args, "config"));
    // Same git-artifact resolver the main store path installs, so a Git-archived Candidate can be
    // materialized through its local fixed objects.
    opened.store.setGitArtifactResolver(ref => { if (!ref.git_artifact) throw validation("artifact", "Git artifact metadata required"); return deriveLocalGitArtifact(cwd, ref.git_artifact.binding); });
    try { return await executeVerificationRun(args, { store: opened.store, cwd, databaseId: opened.config.database.expected_database_id, attribution: () => attribution(args, cwd), validateClone: (path, repositoryId) => validateRepositoryClone(new Module(opened.store), path, repositoryId) }); }
    finally { await opened.store.close(); }
  }
  if (group === "eval") {
    if (bool(args, "help")) return { result_type: "patchledger.result.help/v1", command: "help", usage: evalHelp() + '\n\n' + qaDraftHelp() };
    if (isQADraftCommand(args)) {
      validateQADraftArgs(args);
      if (!qaDraftNeedsLedger(args)) return executeQADraft(args, cwd);
      requireNoLegacyBrandState(cwd, value(args, 'config'));
      const opened = await openStore(value(args, 'config'));
      try { return await executeQADraft(args,cwd,opened.store,opened.config.database.expected_database_id,()=>attribution(args,cwd)); }
      finally { await opened.store.close(); }
    }
    validateEvalArgs(args);
    requireNoLegacyBrandState(cwd, value(args, "config"));
    const opened = await openStore(value(args, "config"));
    opened.store.setGitArtifactResolver(ref => { if (!ref.git_artifact) throw validation("artifact", "Git artifact metadata required"); return deriveLocalGitArtifact(cwd, ref.git_artifact.binding); });
    try { return await executeEval(args, opened.store, cwd, opened.config.database.expected_database_id, () => attribution(args, cwd)); }
    finally { await opened.store.close(); }
  }
  // `--version` / `-v` print the installed package version without touching
  // storage.  It must stay available even before the config/store opens, and
  // under `--json` it returns a contract-shaped version result.
  if ((hasOption(args, "version") && args.positionals.length === 0) || (group === "version") || (args.positionals.length === 1 && args.positionals[0] === "-v")) {
    validateOptionKeys(args);
    return { result_type: "patchledger.result.version/v1", command: "version", version: cliVersion() };
  }
  if (bool(args, "help") || group === "help" || group === "--help") {
    validateHelpArguments(args);
    // `--help` attached to a command (e.g. `requirement list --help`) returns
    // that command's own option list instead of the global usage.  The global
    // `help` topic form keeps its existing single-topic behavior.
    if (args.positionals.length >= 1 && args.positionals[0] !== "help" && args.positionals[0] !== "--help") {
      const helpGroup = args.positionals[0];
      const helpAction = args.positionals[1] ?? "";
      const specialActions: Record<string, string[]> = { config: ["show", "path", "validate", "set-development-mode"] };
      const actions = actionSets[helpGroup] ?? specialActions[helpGroup];
      const actionless = helpGroup === "init" || helpGroup === "doctor" || helpGroup === "review" || helpGroup === "trace";
      if ((!actions && !actionless) || (helpAction && !(actions ?? []).includes(helpAction)) || (actionless && helpAction)) {
        throw validation("command", `command is not implemented: ${helpGroup}${helpAction ? ` ${helpAction}` : ""}`);
      }
      return { result_type: "patchledger.result.help/v1", command: "help", usage: formatCommandHelp(commandHelp(helpGroup, helpAction)) };
    }
    return { result_type: "patchledger.result.help/v1", command: "help", usage: "grounds doctor | migrate data | migrate patchledger | install skill [path] | init | review [candidate-id] | trace | delivery-link | integration | contract | draft (legacy alias: workspace) | code-workspace | requirement | repository | issue | devrun | preflight | candidate | selection | completion | verification | ledger | eval | env | db | config" };
  }
  if (!group) throw validation("command", "expected install, init, review, config, db, workspace, repository, requirement, issue, devrun, candidate, selection, verification, or ledger");
  if (group === "doctor") {
    validateCommandArguments(args, group, action);
    if (action) throw validation("command", "doctor does not take an action");
    if (hasOption(args, "skills-path") && !value(args, "skills-path").trim()) throw validation("skills-path", "must not be empty");
    return installationStatus(value(args, "skills-path") || defaultSkillsDirectory());
  }
  if (group === "migrate") {
    if (!["patchledger", "data"].includes(action)) throw validation("migrate", "expected patchledger or data");
    validateCommandArguments(args, group, action);
    if (action === "data") return executeDataMigration({ cwd, dryRun: bool(args, "dry-run"),
      ...(hasOption(args, "file") ? { file: required(args, "file") } : {}),
      ...(hasOption(args, "data-root") ? { targetRoot: required(args, "data-root") } : {}),
      ...(hasOption(args, "legacy-config") ? { oldConfig: required(args, "legacy-config") } : {}),
    }, storeForConfig);
    return migratePatchLedgerBrand({ cwd, legacyConfig: value(args, "legacy-config") || undefined, dryRun: bool(args, "dry-run") });
  }
  if (group === "init") {
    validateCommandArguments(args, group, action);
    if (action) throw validation("command", "init does not take an action");
    if (hasOption(args, "config") && !value(args, "config").trim()) throw validation("config", "must not be empty");
    if (hasOption(args, "path") && !value(args, "path").trim()) throw validation("path", "must not be empty");
    requireNoLegacyBrandState(cwd, value(args, "config"));
    return initCommand(args, io, initObservedAbsent);
  }
  if (group === "config") {
    if (!action || !["show", "path", "validate", "set-development-mode"].includes(action)) throw validation("config", "expected show, path, validate, or set-development-mode");
    validateCommandArguments(args, group, action);
    if (hasOption(args, "config") && !value(args, "config").trim()) throw validation("config", "must not be empty");
    requireNoLegacyBrandState(cwd, value(args, "config"));
    return configCommand(args);
  }
  if (group === "install") {
    if (action !== "skill") throw validation("install", "expected skill");
    validateCommandArguments(args, group, action);
    const requestedPath = args.positionals[2];
    if (requestedPath !== undefined && !requestedPath.trim()) throw validation("path", "must not be empty");
    const target = requestedPath === undefined ? defaultSkillsDirectory() : resolve(cwd, requestedPath);
    return installGroundsSkills(target, bundledPluginRoot(), bool(args, "link"));
  }
  const isReview = group === "review" || group === "trace";
  if (!isReview && !(group in actionSets)) throw validation("command", `command is not implemented: ${group}`);
  if (!isReview && (!action || !actionSets[group].includes(action))) throw validation(group, `expected ${actionSets[group].join(", ")}`);
  validateCommandArguments(args, group, isReview ? "" : action);
  if (isReview && bool(args, "markdown") && bool(args, "summary")) throw validation("summary", "cannot be combined with --markdown");
  // `--cursor` continues a Candidate-bound Verification page with --paged; the
  // resource lists accept it (with or without --limit) for cursor-paged mode.
  if (hasOption(args, "cursor") && !bool(args, "paged") && !pagedListCommands.has(`${group}:${action}`)) throw validation("cursor", "requires --paged");
  if (isReview && bool(args, "markdown") && jsonOutputRequested(args)) throw validation("markdown", "cannot be combined with --json");
  // An explicitly supplied config path is never equivalent to the platform
  // default.  Treat `--config=` as a usage error before touching the file
  // system so a typo cannot silently operate on another ledger.
  if (hasOption(args, "config") && !value(args, "config").trim()) throw validation("config", "must not be empty");
  if (group === "devrun" && action === "context" && args.values["allow-submitted"] !== undefined) throw validation("allow-submitted", "is not supported; context is available only for an open DevRun");
  if (group === "verification" && action === "template" && hasOption(args, "context")) {
    if (args.positionals[2] !== undefined || hasOption(args, "candidate")) throw validation("candidate", "use either a Candidate ID or --context, not both");
    const language = contentLanguagePolicy(hasOption(args, "content-language") ? value(args, "content-language") : undefined, undefined);
    const context = decodeBlindContextFile(required(args, "context"));
    // A quality context is recognised by its own format, so the offline path needs no extra flag.
    if ((context as { format?: unknown } | null)?.format === QUALITY_CONTEXT_FORMAT) return qualityTemplateFromBlindContext(context, language?.language);
    return verificationTemplateFromBlindContext(context, language?.language);
  }
  if (group === "verification" && (action === "handoff" || action === "independent-digest")) {
    const subject = offlineReportSubject(required(args, "file"));
    if (action === "independent-digest") return { result_type: "patchledger.result.independent-digest/v1", command: "verification.independent-digest", candidate_id: subject.report.candidate_id, report_format: subject.report.format, independent_digest: subject.independentDigest };
    if (hasOption(args, "independent-digest") && value(args, "independent-digest") !== subject.independentDigest) throw validation("independent-digest", "does not match the report's independent part; the blind assessment changed after it was fixed");
    const languageWarnings = checkContentLanguage(subject.prose, contentLanguagePolicy(hasOption(args, "content-language") ? value(args, "content-language") : undefined, hasOption(args, "language-override-reason") ? value(args, "language-override-reason") : undefined));
    const handoff = subject.sign(attribution(args, cwd));
    const target = materialOutput(args, cwd, (sessions, id) => sessions.handoffPath(subject.report.candidate_id, id, reportRole(subject.report.format)));
    const outputPath = target ? writeMaterial(target, handoff) : undefined;
    return { result_type: subject.handoffResultType, command: "verification.handoff", candidate_id: subject.report.candidate_id, report_digest: handoff.report_digest, independent_digest: subject.independentDigest, handoff, ...(outputPath ? { output_path: outputPath } : {}), warnings: languageWarnings };
  }
  if (group === "db") {
    requireNoLegacyBrandState(cwd, value(args, "config"));
    const configFile = configPath(value(args, "config"));
    if (!existsSync(configFile)) throw new DomainError("SCHEMA_INCOMPATIBLE", `configuration file does not exist: ${configFile}`, false, schemaDetails(SCHEMA_VERSION, `configuration file does not exist: ${configFile}`));
    const config = loadConfig(configFile);
    const store = storeForConfig(config);
    store.setGitArtifactResolver(ref => { if (!ref.git_artifact) throw validation("artifact", "Git artifact metadata required"); return deriveLocalGitArtifact(cwd, ref.git_artifact.binding); });
    try {
      if (action === "status") { const inspected = await store.inspectIntegrity(); if (inspected.metadata.database_id !== config.database.expected_database_id) throw databaseIdentityMismatch(); return databaseResult("db.status", inspected.metadata, inspected.report); }
      if (action === "migrate") { const before = await store.inspect(); if (before.database_id !== config.database.expected_database_id) throw databaseIdentityMismatch(); return databaseResult("db.migrate", await store.migrate()); }
      const metadata = await store.open();
      if (metadata.database_id !== config.database.expected_database_id) throw databaseIdentityMismatch();
      return databaseResult("db.test", metadata);
    } finally { await store.close(); }
  }
  if (group === "ledger" && action === "show") {
    const eventID = resourceID(args, "event", "event");
    if (!isUUIDv7(eventID)) throw validation("event", "must be a lowercase UUIDv7; use ledger list to discover event IDs");
  }
  // Every ordinary ledger or repository command fails closed when legacy
  // local state is visible. Help, version, doctor, Skill installation and the
  // explicit migration command remain available so the user can recover.
  requireNoLegacyBrandState(cwd, value(args, "config"));
  if (group === "contract" && action === "render") {
    const workspace = hasOption(args, "workspace");
    const fixed = hasOption(args, "requirement") || hasOption(args, "issue");
    if (workspace === fixed) throw validation("source", "select exactly one Workspace or fixed Requirement/Issue versions");
    if (workspace) required(args, "workspace");
    if (hasOption(args, "output")) required(args, "output");
    const format = value(args, "format", "html");
    if (!["html", "markdown"].includes(format)) throw validation("format", "must be html or markdown");
    if (!hasOption(args, "output")) {
      if (fixed) throw validation("output", "fixed versions require an explicit output directory");
      if (format !== "html") throw validation("format", "interactive sessions require html; markdown requires --output");
      const name = required(args, "workspace");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) throw validation("workspace", "invalid name");
      const config = loadConfig(configPath(value(args, "config")));
      const path = join(draftsRoot(config.database.expected_database_id), name);
      if (new JsonWorkspaceStore(path).read().manifest.database_id !== config.database.expected_database_id) throw databaseIdentityMismatch();
      const editor = await startWorkspaceEditor(path);
      return { result_type: "grounds.result.contract-session/v1", command: "contract.render", mode: "interactive", url: editor.url, version: editor.version, source: editor.source, editable: editor.editable };
    }
  }
  if (group === "workspace" && ["new", "list", "show"].includes(action)) {
    const config = loadConfig(configPath(value(args, "config")));
    if (!["json", "markdown"].includes(value(args, "format", "json"))) throw validation("format", "must be json or markdown");
    const local = new WorkspaceModule(undefined, cwd, "warn", () => attribution(args, cwd), config.database.expected_database_id, newUUIDv7, value(args, "format", "json") !== "markdown");
    if (action === "new") return local.new(args.positionals[2], value(args, "remote"), contentLanguagePolicy(hasOption(args, "content-language") ? value(args, "content-language") : undefined, undefined));
    return action === "list" ? local.list() : local.show(args.positionals[2], cwd);
  }
  if (group === "workspace" && ["read","save","edit","migrate","resolve","bind"].includes(action)) {
    const name=args.positionals[2]; if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name))throw validation("workspace","invalid name");
    const config = loadConfig(configPath(value(args, "config")));
    const path=join(draftsRoot(config.database.expected_database_id),name);const local=new JsonWorkspaceStore(path);
    if (JSON.parse(safeRead(local.path, 32 * 1024 * 1024).toString()).database_id !== config.database.expected_database_id) throw databaseIdentityMismatch();
    if (action === "bind") {
      const remote = normalizeRemote(required(args, "remote-url"));
      const result = await local.update(required(args, "expected-version"), manifest => {
        if (manifest.requirement.id || manifest.issues.some(issue => issue.id) || existsSync(join(path, ".pending-publication.json"))) throw validation("draft", "repository binding requires an unpublished draft without pending publication");
        return { ...manifest, repository_remote: remote };
      });
      return { result_type: "grounds.result.workspace-draft/v2", command: "workspace.bind", ...result };
    }
    if(action==="read")return {result_type:"grounds.result.workspace-draft/v2",command:"workspace.read",...local.read()};
    if(action==="migrate")return {result_type:"grounds.result.workspace-migrate/v2",command:"workspace.migrate",...await local.migrateLegacy(bool(args,"dry-run")) as object};
    if(action==="edit"){const editor=await startWorkspaceEditor(path);return {result_type:"grounds.result.workspace-editor/v2",command:"workspace.edit",url:editor.url,version:editor.version,source:editor.source,editable:editor.editable};}
    const draft=JSON.parse(readFileSync(resolve(cwd,required(args,"file")),"utf8"));
    if(action==="resolve")return {result_type:"grounds.result.workspace-draft/v2",command:"workspace.resolve",...await local.resolve(draft,required(args,"expected-version"))};
    return {result_type:"grounds.result.workspace-draft/v2",command:"workspace.save",...await local.save(draft,required(args,"expected-version"))};
  }
  const opened = await openStore(value(args, "config"));
  opened.store.setGitArtifactResolver(ref => { if (!ref.git_artifact) throw validation("artifact", "Git artifact metadata required"); return deriveLocalGitArtifact(cwd, ref.git_artifact.binding); });
  const preflightService = (): PreflightService => new PreflightService(opened.store, cwd);
  const preflightCoordinator = preflightService().coordinator({ refresh: bool(args, "refresh"), ...(hasOption(args, "preflight") ? { assessment_id: required(args, "preflight") } : {}) });
  const module = new Module(opened.store, newUUIDv7, async (left, right) => diffTrees(cwd, left, right), (snapshot, base) => snapshotRelation(cwd, snapshot, base), preflightCoordinator);
  const actor = (): Attribution => attribution(args, cwd);
  let preparedMarkdown: PreparedReviewMarkdown | undefined;
  try {
    return await (async () => {
    if (group === "code-workspace" && Object.hasOwn(repositoryImageCommands, action)) return executeRepositoryImage({
      action: action as keyof typeof repositoryImageCommands, args, store: opened.store, cwd, attribution: actor, operationID: () => operationID(args, io) });
    if (group === "code-workspace" && Object.hasOwn(environmentControlCommands, action)) return executeEnvironmentControl({
      action: action as keyof typeof environmentControlCommands, args, store: opened.store, attribution: actor, operationID: () => operationID(args, io) });
    if (group === "code-workspace" && Object.hasOwn(codeCleanupCommands, action)) return executeCodeCleanup({
      action: action as keyof typeof codeCleanupCommands, args, store: opened.store, cwd, attribution: actor, operationID: () => operationID(args, io) });
    if (group === "code-workspace" && Object.hasOwn(codeExecutionCommands, action)) return executeCodeExecution({
      action: action as keyof typeof codeExecutionCommands, args, store: opened.store, cwd, io, attribution: actor, operationID: () => operationID(args, io) });
    if (group === "code-workspace") {
      const workspaces = new CodeWorkspaces(opened.store), id = args.positionals[2]!;
      if (action === "environment-save" || action === "environment-show") {
        const environments = new RepositoryEnvironments(opened.store);
        let content: unknown;
        if (action === "environment-save") {
          try { content = JSON.parse(safeRead(resolve(cwd, required(args, "file")), 64 * 1024).toString("utf8")); }
          catch { throw validation("file", "requires a bounded regular JSON environment configuration"); }
        }
        const environment = action === "environment-show" ? await environments.revision(id)
          : await environments.save({ operation_id: operationID(args, io), environment_id: id,
            repository_id: required(args, "repository"), expected_version: integerValue(args, "expected-version", 0),
            configuration: content as RepositoryEnvironmentConfiguration, attribution: actor() });
        return { result_type: "grounds.result.repository-environment/v1", command: `code-workspace.${action}`, environment };
      }
      if (action === "route-prepare" || action === "route-show" || action === "route-bind") {
        const routes = new CodeWorkspaceRoutes(opened.store);
        if (action === "route-show") return { result_type: "grounds.result.code-workspace/v1", command: "code-workspace.route-show", route: await routes.show(id) };
        const root = dataRoot(hasOption(args, "data-root") ? required(args, "data-root") : undefined, cwd);
        if (action === "route-bind") {
          const owner = await workspaces.instance((await routes.show(id)).instance_id);
          if (owner.data_root !== root) throw validation("data-root", "differs from the recorded instance");
        }
        const request = { operation_id: operationID(args, io), attribution: actor(), data_root: root, host_id: hostIdentity(join(root, "runtime")) };
        const boundRoute = action === "route-bind" ? await routes.show(id) : undefined;
        const boundRun = boundRoute?.dev_run_id ? await opened.store.read(tx => tx.getDevRun(boundRoute.dev_run_id!)) : undefined;
        const executionMode = action === "route-bind" ? boundRun ? boundRun.execution_mode : await selectDevelopmentMode(args, io, opened.config) : undefined;
        if (boundRun && hasOption(args, "development-mode")) {
          if (!executionMode) throw validation("development-mode", "historical DevRun has no recorded mode; start a new DevRun");
          resumeDevelopmentMode(executionMode.mode, value(args, "development-mode"));
        }
        const route = action === "route-bind" ? await routes.bindDevRun({ ...request, route_id: id, ...(executionMode ? { execution_mode: executionMode } : {}) })
          : await routes.prepare({ ...request, instance_id: id, issue_slug: required(args, "issue-slug") });
        return { result_type: "grounds.result.code-workspace/v1", command: `code-workspace.${action}`, route };
      }
      if (action === "create" || action === "restore" || action === "show" || action === "prepare") {
        const root = dataRoot(hasOption(args, "data-root") ? required(args, "data-root") : undefined, cwd);
        const instance = action === "show" ? await workspaces.instance(id) : action === "prepare"
          ? await workspaces.prepareInstance({ instance_id: id, host_id: hostIdentity(join(root, "runtime")), data_root: root, allow_cached: bool(args, "allow-cached") })
          : action === "restore" ? await workspaces.restoreInstance({ operation_id: operationID(args, io), attribution: actor(),
            source_instance_id: id, candidate_id: required(args, "candidate"), context_policy: required(args, "context") as "original",
            host_id: hostIdentity(join(root, "runtime")) })
          : await workspaces.createInstance({
          operation_id: operationID(args, io), attribution: actor(), configuration_id: required(args, "configuration"),
          configuration_version: integerValue(args, "version", 1), issue_id: required(args, "issue"), issue_version: integerValue(args, "issue-version", 1),
          host_id: hostIdentity(join(root, "runtime")),
        });
        return { result_type: "grounds.result.code-workspace/v1", command: `code-workspace.${action}`, instance };
      }
      let content: unknown;
      if (action === "config-save") {
        const bytes = safeRead(resolve(cwd, required(args, "file")), 64 * 1024);
        try { content = JSON.parse(bytes.toString("utf8")); }
        catch { throw validation("file", "requires a JSON Workspace configuration"); }
      }
      const configuration = action === "config-show"
        ? await workspaces.configuration(id, hasOption(args, "version") ? integerValue(args, "version", 1) : undefined)
        : await workspaces.saveConfiguration({ configuration_id: id, expected_version: integerValue(args, "expected-version", 0),
          operation_id: operationID(args, io), attribution: actor(), configuration: content as import("./code-workspace.js").WorkspaceConfiguration });
      return { result_type: "grounds.result.code-workspace/v1", command: `code-workspace.${action}`, configuration };
    }
    if (group === "repository" && Object.hasOwn(repositoryArchiveCommands, action)) return executeRepositoryArchive({ action: action as keyof typeof repositoryArchiveCommands, args, store: opened.store, attribution: actor, operationID: () => operationID(args, io) });
    if (group === "integration") {
      const integration = new IntegrationService(opened.store, cwd);
      const who = () => ({ operation_id: operationID(args, io), attribution: actor() });
      const record = action === "observe" ? await integration.observe({ candidate_id: required(args, "candidate"), selection_id: required(args, "selection"), selection_version: integerValue(args, "selection-version", 1), source: { remote: required(args, "source-remote"), ref: required(args, "source-ref") }, source_commit: required(args, "source-commit"), refresh: bool(args, "refresh") }, who())
        : action === "authorize" ? await integration.authorize(required(args, "observation"), required(args, "reason"), who())
        : action === "consume" ? await integration.consume(required(args, "authorization"), who())
        : action === "landing" ? await integration.landing(required(args, "observation"), { ...(hasOption(args, "commit") ? { commit: required(args, "commit") } : {}), ...(hasOption(args, "provenance") ? { provenance: required(args, "provenance") as LandingSource } : {}), refresh: bool(args, "refresh"), ...(hasOption(args, "adoption-file") ? { adoption: JSON.parse(safeRead(resolve(cwd, required(args, "adoption-file")), 16 * 1024).toString()) } : {}) }, who())
        : action === "show" ? await integration.show(resourceID(args, "record", "integration")) : undefined;
      if (!record) throw validation("command", "unknown integration action");
      let landing_archive: unknown;
      if (record.kind === "landing" && record.landing?.actual_landing && action === "landing") {
        // Adoption is already durably recorded. Archival can remain pending without undoing that fact.
        const landed = record.landing.actual_landing;
        const predecessor = record.landing.target_predecessor;
        const archives = new CandidateArchiveService(opened.store, cwd);
        if (predecessor?.state !== "confirmed" || !predecessor.commit) {
          landing_archive = { status: predecessor?.state === "conflict" ? "unknown" : "pending", operation_id: record.id,
            reason: predecessor?.state === "conflict" ? "actual_target_predecessor_conflict" : "actual_target_predecessor_unknown" };
        } else try {
          const descriptor = await module.candidateArtifactDescriptor(record.candidate_id);
          const repository = await module.showRepository(descriptor.repository_id!);
          let row = await archives.prepare({ operation_id: record.id, purpose: "landing", owner_id: record.candidate_id, candidate_id: record.candidate_id,
            request: { landing_record_id: record.id, landed_commit: landed.oid, target_predecessor: predecessor.commit.oid }, attribution: actor(),
            binding: () => ({ repository_id: descriptor.repository_id!, canonical_remote: repository.canonical_remote, archive_ref: `refs/tags/grounds/deliveries/${record.id}`, source_commit: landed.oid, ordered_parents: landed.parents, result_tree: landed.tree_oid, base_commit: predecessor.commit.oid, retained_commits: [predecessor.commit.oid] }) });
          if (value(args, "archive-policy") || process.env.GROUNDS_ARCHIVE_POLICY || (await new RepositoryArchiveAccess(opened.store).status(descriptor.repository_id!)).binding) {
            const verified = await archives.verify(record.id, archivePolicyFor(opened.store, cwd, value(args, "archive-policy")));
            row = await archives.committed(record.id, { landing_record_id: record.id, receipt: verified.artifact.receipt });
          }
          landing_archive = { status: archiveOperation(row).phase === "committed" ? "confirmed" : "pending", operation_id: record.id, operation: row };
        } catch (error) { landing_archive = { status: "unknown", operation_id: record.id, reason: "adoption_recorded_but_archive_requires_reconciliation", ...(error instanceof DomainError && error.details.protection_diagnosis ? { protection_diagnosis: error.details.protection_diagnosis } : {}) }; }
      }
      if (record.kind === "landing" && record.landing?.actual_landing && action === "show") {
        const row = await opened.store.read(tx => tx.getRuntimeRecord("runtime_operation", record.id));
        const predecessor = record.landing.target_predecessor;
        landing_archive = predecessor?.state !== "confirmed" || !predecessor.commit
          ? {status: predecessor?.state === "conflict" ? "unknown" : "pending", operation_id: record.id, ...(row ? {operation: row} : {}), reason: predecessor?.state === "conflict" ? "actual_target_predecessor_conflict" : "actual_target_predecessor_unknown"}
          : row?.data.format === "grounds.candidate-archive-operation/v1"
            ? {status: archiveOperation(row).phase === "committed" ? "confirmed" : archiveOperation(row).phase === "unknown" ? "unknown" : "pending", operation_id: record.id, operation: row}
            : {status: "pending", operation_id: record.id};
      }
      return { result_type: "patchledger.result.integration/v1", command: `integration.${action}`, record, ...(landing_archive ? { landing_archive } : {}),
        ...(record.kind === "authorization" ? { authorization_state: await integration.authorizationState(record.id) } : {}) };
    }
    if (group === "delivery-link" && action === "show") return module.showDeliveryLink(args.positionals[2], hasOption(args, "version") ? integerValue(args, "version", 1) : undefined);
    if (group === "delivery-link" && action === "withdraw") return module.withdrawDeliveryLink({ link_id: args.positionals[2], operation_id: operationID(args, io), expected_version: integerValue(args, "expected-version", 0), reason: required(args, "reason"), attribution: actor() });
    if (group === "delivery-link" && action === "record") {
      const operation = operationID(args, io), expected = integerValue(args, "expected-version", 0);
      const caller = actor(), commit = required(args, "commit");
      const repository = await resolveCurrentRepository(module, args, cwd);
      const candidate = value(args, "candidate") || undefined;
      const replay = await module.completedDeliveryLinkOperation({ operation_id: operation, expected_version: expected, attribution: caller, repository_id: repository.id, candidate_id: candidate, commit_oid: commit });
      if (replay) return replay;
      const proof = await withHistoryRead(async () => deliveryProof(module, cwd, repository.id, candidate ?? await candidateFromReceipt(module, cwd, repository.id, opened.config.database.expected_database_id), commit));
      return module.recordDeliveryLink({ operation_id: operation, expected_version: expected, attribution: caller, proof });
    }
    if (group === "trace") {
      const repository = await resolveCurrentRepository(module, args, cwd);
      if (hasOption(args, "at") && ["path", "start-line", "end-line", "snippet-file"].some(key => hasOption(args, key))) throw validation("source", "--at cannot be combined with other source selectors");
      if (hasOption(args, "snippet-file") && ["path", "start-line", "end-line"].some(key => hasOption(args, key))) throw validation("source", "--snippet-file cannot be combined with a path or range");
      const at = value(args, "at");
      const match = at ? /^(.*):(\d+)(?:-(\d+))?$/.exec(at) : undefined;
      if (at && !match) throw validation("at", "expected path:start-end");
      return traceSource(discoverRepository(cwd).root, repository.id, {
        snippet_file: value(args, "snippet-file") || undefined,
        candidate_limit: hasOption(args, "limit") ? integerValue(args, "limit", 1) : 200,
        path: match?.[1] ?? (value(args, "path") || undefined),
        start_line: match ? Number(match[2]) : args.values["start-line"] === undefined ? undefined : integerValue(args, "start-line", 1),
        end_line: match ? Number(match[3] ?? match[2]) : args.values["end-line"] === undefined ? undefined : integerValue(args, "end-line", 1),
      }, module, opened.config.database.expected_database_id);
    }
    if (group === "review") {
      const positionalCandidate = args.positionals[1];
      if (positionalCandidate !== undefined && hasOption(args, "candidate")) throw validation("candidate", "use either positional candidate or --candidate, not both");
      const marker = positionalCandidate === undefined && !hasOption(args, "candidate") ? readReviewWorktreeMarker(cwd) : undefined;
      const candidateID = positionalCandidate ?? (hasOption(args, "candidate") ? value(args, "candidate") : marker?.candidate_id);
      if (!candidateID) throw validation("candidate", "is required outside a Grounds review worktree");
      if (marker && marker.database_id !== opened.config.database.expected_database_id) throw new DomainError("DATABASE_ID_MISMATCH", "review worktree belongs to a different database", false, { reason: "review marker database_id does not match config expected_database_id" });
      const location = reviewLocation(args);
      const options = { include_patch: bool(args, "include-diff"), ...(location ? { location } : {}) };
      const checkMarker = (trace: ReviewTraceResult | ReviewSummaryResult): void => {
      if (marker) {
        const facts = trace.trace;
        if (marker.candidate_id !== facts.candidate.candidate_id || marker.repository_id !== facts.repository.id || marker.baseline_oid !== facts.baseline.git_oid || marker.result_tree_oid !== facts.artifact.result_tree_oid || marker.patch_digest !== facts.artifact.patch_digest) {
          throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "review worktree metadata does not match the immutable Candidate", false, { resource_id: candidateID, reason: "review marker facts differ from the ledger" });
        }
        if (location) assertReviewWorktreeCandidateArtifact(cwd, marker);
      }
      };
      if (bool(args, "markdown")) { preparedMarkdown = await prepareReviewMarkdown(module, candidateID, options, checkMarker); return preparedMarkdown; }
      const trace = bool(args, "summary") ? await module.reviewSummary(candidateID, options) : await module.reviewCandidate(candidateID, options);
      checkMarker(trace);
      return trace;
    }
    if (group === "contract" && action === "render") {
      return renderContractReview(module, { workspace: value(args, "workspace") || undefined, requirement: value(args, "requirement") || undefined, issues: values(args, "issue"), output: resolve(cwd, required(args, "output")), format: value(args, "format", "html") }, value(args, "workspace") ? new WorkspaceModule(module, cwd, opened.policy, actor, opened.config.database.expected_database_id) : undefined);
    }
    if (group === "devrun" && action === "admit") {
      const runID = resourceID(args, "dev-run", "dev_run");
      const { record, data } = await preflightService().admit({
        operation_id: operationID(args, io), attribution: actor(),
        dev_run_id: runID,
        assessment_id: resourceID(args, "preflight", "preflight"),
        refresh: bool(args, "refresh"),
        ...(hasOption(args, "expected-version") ? { expected_version: integerValue(args, "expected-version", 1) } : {}),
        ...(hasOption(args, "expected-head") ? { expected_head: required(args, "expected-head") } : {}),
      });
      return { result_type: "grounds.result.preflight-admission/v1", command: "devrun.admit", dev_run_id: runID, preflight: record, admission: { observation_id: data.observation_id, assessment_id: data.assessment_id, target_commit: data.target_commit, base_commit: data.base_commit, admitted_at: data.admitted_at } };
    }
    if (group === "devrun" && action === "prepare" && hasOption(args, "issue")) {
      // New-round preparation is handled by the shared start block below, which
      // builds the recovery/sync scene without granting admission.
      // fall through to the combined start/prepare branch.
    } else if (group === "devrun" && action === "prepare") {
      // Annotate an existing open run with a restorable preparation scene. It
      // never asserts admission, and a target run stays `preparing` until admit.
      const runID = resourceID(args, "dev-run", "dev_run");
      const detail = await module.showDevRun(runID);
      if (!detail.development) throw validation("dev-run", "prepare requires a managed target-flow DevRun; use devrun start for a new round");
      const service = preflightService();
      const record = await service.markPreparing({ operation_id: operationID(args, io), attribution: actor(), dev_run_id: runID });
      const preflight = await service.devRunReadModel(runID);
      const route = await opened.store.read(tx => tx.getRuntimeRecord("runtime_operation", detail.development!.workspace_id));
      const local = route?.data.format === "grounds.code-workspace-route/v1" ? undefined
        : await new DevWorktreeModule(cwd, opened.config.database.expected_database_id, newUUIDv7, opened.store).inspectAuthoritative(runID);
      return { result_type: "grounds.result.preflight-preparation/v1", command: "devrun.prepare", dev_run_id: runID, prepare_id: record.id,
        ...(local ? { local_worktree: local } : {}), ...(preflight ? { preflight } : {}) };
    }
    if (group === "preflight") {
      const service = preflightService();
      if (action === "show") return { result_type: "grounds.result.preflight/v1", command: "preflight.show", preflight: await service.show(resourceID(args, "preflight", "preflight")) };
      if (action === "observe") {
        const phase = required(args, "phase");
        if (phase !== "definition" && phase !== "publish" && phase !== "start") throw validation("phase", "must be definition, publish or start");
        const issueID = hasOption(args, "issue") ? required(args, "issue") : undefined;
        const runID = hasOption(args, "dev-run") ? required(args, "dev-run") : undefined;
        if (hasOption(args, "target-remote") !== hasOption(args, "target-branch")) throw validation("target", "target-remote and target-branch must be supplied together");
        let target = hasOption(args, "target-remote") ? { remote: required(args, "target-remote"), ref: required(args, "target-branch") } : undefined;
        let binding: Awaited<ReturnType<WorkspaceModule["pendingPublishBinding"]>>;
        if (phase === "publish") {
          if (issueID || runID) throw validation("workspace", "publish observations bind the actual pending Workspace publication");
          const workspace = new WorkspaceModule(module, cwd, opened.policy, actor, opened.config.database.expected_database_id);
          binding = await workspace.pendingPublishBinding(required(args, "workspace"), cwd, value(args, "expected-version"));
          if (!binding) throw validation("workspace", "there is no target Issue change requiring publication preflight");
          if (target && !binding.targets.some(item => item.remote === target!.remote && item.ref === target!.ref)) throw validation("target", "is not a target of this publication");
          if (!target && binding.targets.length !== 1) throw validation("target", "select each declared publication target explicitly and assess it separately");
          target ??= binding.target;
        } else if (hasOption(args, "workspace") || hasOption(args, "expected-version")) throw validation("phase", "Workspace version options only apply to publish observations");
        let issueRevisionID: string | undefined;
        if (hasOption(args, "issue-version")) {
          const selectedIssue = issueID ?? (runID ? (await module.showDevRun(runID)).issue.id : undefined);
          if (!selectedIssue) throw validation("issue-version", "requires issue or dev-run");
          issueRevisionID = (await module.contractIssue(selectedIssue, integerValue(args, "issue-version", 1))).revision.id;
        }
        let repositoryId: string | undefined;
        let canonicalRemote = binding?.canonical_remote;
        if (hasOption(args, "repository")) repositoryId = required(args, "repository");
        else if (!issueID && !runID && !canonicalRemote) {
          const selected = selectRemote(discoverRepository(cwd), value(args, "remote") || target?.remote || "");
          canonicalRemote = selected.canonical;
        }
        const record = await service.observe({
          operation_id: operationID(args, io), attribution: actor(), phase, refresh: bool(args, "refresh"),
          ...(repositoryId ? { repository_id: repositoryId } : {}), ...(canonicalRemote ? { canonical_remote: canonicalRemote } : {}),
          ...(issueID ? { issue_id: issueID } : {}), ...(issueRevisionID ? { issue_revision_id: issueRevisionID } : {}),
          ...(runID ? { dev_run_id: runID } : {}), ...(target ? { target } : {}),
          ...(binding?.reviewed_version ? { scope_digest: binding.reviewed_version } : {}),
          ...(binding ? { content_digest: binding.content_digest, definition_commit: binding.definition_commit } : {}),
        });
        return { result_type: "grounds.result.preflight-observation/v1", command: "preflight.observe", ...observationView(record) };
      }
      // assess
      let file: { assessment?: unknown; author?: unknown; rationale?: unknown; affected?: unknown };
      try { file = JSON.parse(safeRead(resolve(cwd, required(args, "file")), 256 * 1024).toString("utf8")); }
      catch { throw validation("file", "requires a readable bounded JSON assessment object"); }
      const record = await service.assess({
        operation_id: operationID(args, io), attribution: actor(),
        observation_id: resourceID(args, "observation", "observation"),
        file: file as AssessInput["file"],
      });
      return { result_type: "grounds.result.preflight-assessment/v1", command: "preflight.assess", preflight: record, ...assessmentView(record) };
    }
    if (group === "workspace") {
      if(!["json","markdown"].includes(value(args,"format","json")))throw validation("format","must be json or markdown");
      const workspace = new WorkspaceModule(module, cwd, opened.policy, actor, opened.config.database.expected_database_id, newUUIDv7, value(args,"format","json") !== "markdown");
      const name = args.positionals[2];
      if (action === "new") return workspace.new(name, value(args, "remote"), contentLanguagePolicy(hasOption(args, "content-language") ? value(args, "content-language") : undefined, undefined));
      if (action === "open") {
        const kind = args.positionals[2]; const id = args.positionals[3];
        if (kind === "requirement") return workspace.openRequirement(id, value(args, "name"), value(args, "remote"));
        if (kind === "issue") { const bind = value(args, "bind-requirement", "preserve"); if (bind !== "preserve" && bind !== "current") throw validation("bind-requirement", "must be preserve or current"); return workspace.openIssue(id, value(args, "name"), bind, value(args, "remote")); }
        throw validation("workspace", "open expects requirement or issue");
      }
      if (action === "list") return workspace.list();
      if (action === "show") return workspace.show(name, cwd);
      if (action === "publish") {
        const language = contentLanguagePolicy(hasOption(args, "content-language") ? value(args, "content-language") : undefined, hasOption(args, "language-override-reason") ? value(args, "language-override-reason") : undefined);
        const pendingBinding = bool(args, "dry-run") ? await workspace.pendingPublishBinding(name, cwd, value(args, "expected-version")) : undefined;
        const warnings: Warning[] = pendingBinding ? [{ code: "PREFLIGHT_REQUIRED", message: "the target publication must consume a matching preflight with explicit --refresh; an offline dry-run is not a freshness check" }] : [];
        const published = await workspace.publish(name, cwd, bool(args, "dry-run"), bool(args, "allow-unpublished-baseline"), bool(args, "allow-second-issue-per-repository"), value(args, "override-reason"), language, value(args,"expected-version"));
        return { ...(published.result as Record<string, unknown>), warnings: [...published.warnings, ...warnings] };
      }
      if (action === "abandon-publication") return {result_type:"grounds.result.workspace-recovery/v2",command:"workspace.abandon-publication",...await workspace.abandonPublication(name,required(args,"expected-version")) as object};
      if (action === "rebase") return workspace.rebase(name, cwd);
      if (action === "remove") return workspace.remove(name, cwd, bool(args, "discard-changes"));
    }
    if (group === "requirement" && action === "list") return module.listRequirements(pageRequest(args));
    if (group === "requirement" && action === "show") return module.showRequirement(resourceID(args, "requirement", "requirement"), "", value(args, "issues-cursor"));
    if (group === "repository" && action === "register") {
      if (hasOption(args, "remote") && !value(args, "remote")) throw validation("remote", "must not be empty");
      const selected = selectRemote(discoverRepository(cwd), value(args, "remote")); const result = await module.registerRepository({ operation_id: operationID(args, io), canonical_remote: selected.canonical, attribution: actor() }); return { ...result.result, warnings: result.warnings };
    }
    if (group === "repository" && action === "resolve") {
      if (hasOption(args, "remote") && !value(args, "remote")) throw validation("remote", "must not be empty");
      const local = discoverRepository(cwd); const remotes = value(args, "remote") ? [selectRemote(local, value(args, "remote")).canonical] : local.remotes.map((remote) => remote.canonical); const repository = await module.resolveRepository(remotes); return { result_type: "patchledger.result.repository/v1", command: "repository.resolve", repository_id: repository.id, version: repository.version, canonical_remote: repository.canonical_remote };
    }
    if (group === "repository" && action === "list") return module.listRepositories(pageRequest(args));
    if (group === "repository" && action === "show") return module.showRepository(resourceID(args, "repository", "repository"));
    if (group === "repository" && action === "move") {
      const hasRemoteName = hasOption(args, "remote"); const hasCanonicalOption = hasOption(args, "canonical-remote"); const hasRemoteURLOption = hasOption(args, "remote-url"); const hasCanonicalRemote = hasCanonicalOption || hasRemoteURLOption;
      if (hasRemoteName && !value(args, "remote")) throw validation("remote", "must not be empty");
      if (hasCanonicalOption && hasRemoteURLOption) throw validation("canonical-remote", "use either --canonical-remote or --remote-url");
      if (hasCanonicalRemote && !(value(args, "canonical-remote") || value(args, "remote-url"))) throw validation("canonical-remote", "must not be empty");
      if (hasRemoteName && hasCanonicalRemote) throw validation("remote", "use either --remote or --canonical-remote");
      const remoteName = value(args, "remote"); const canonicalArg = hasCanonicalOption ? value(args, "canonical-remote") : hasRemoteURLOption ? value(args, "remote-url") : "";
      const canonical = canonicalArg || (remoteName ? selectRemote(discoverRepository(cwd), remoteName).canonical : "");
      if (!canonical) throw validation("canonical-remote", "is required");
      return module.moveRepository({ operation_id: operationID(args, io), repository_id: resourceID(args, "repository", "repository"), expected_version: integerValue(args, "expected-version", 1), canonical_remote: normalizeRemote(canonical), attribution: actor() });
    }
    if (group === "repository" && (action === "alias-add" || action === "alias-retire")) {
      // The public contract takes a canonicalizable URL in --remote. Keep
      // --remote-url as a backwards-compatible alias, and only interpret a
      // plain --remote value as a local remote name for old scripts.
      const hasRemoteArg = hasOption(args, "remote"); const hasRemoteURL = hasOption(args, "remote-url");
      const remoteArg = value(args, "remote"); const remoteURL = value(args, "remote-url");
      if (hasRemoteArg && hasRemoteURL) throw validation("remote", "use either --remote or --remote-url");
      if (!hasRemoteArg && !hasRemoteURL) throw validation("remote", "is required");
      if (hasRemoteArg && !remoteArg) throw validation("remote", "must not be empty");
      if (hasRemoteURL && !remoteURL) throw validation("remote-url", "must not be empty");
      const looksLikeURL = (candidate: string): boolean => candidate.includes("://") || (/^[^/\s]+@[^/\s:]+:.+/.test(candidate));
      const remote = remoteURL ? normalizeRemote(remoteURL) : looksLikeURL(remoteArg) ? normalizeRemote(remoteArg) : selectRemote(discoverRepository(cwd), remoteArg).canonical;
      const input = { operation_id: operationID(args, io), repository_id: resourceID(args, "repository", "repository"), expected_version: integerValue(args, "expected-version", 1), remote, attribution: actor() };
      return action === "alias-add" ? module.addRepositoryAlias(input) : module.retireRepositoryAlias(input);
    }
    if (group === "issue" && action === "list") return module.listIssues(value(args, "requirement"), { ...(hasOption(args, "repository") ? { repository_id: value(args, "repository") } : {}), ...(hasOption(args, "status") ? { status: value(args, "status") } : {}), ...(hasOption(args, "sort") ? { sort: value(args, "sort") } : {}), ...(hasOption(args, "has-open-devrun") ? { has_open_dev_run: optionalBoolean(args, "has-open-devrun") } : {}) }, pageRequest(args));
    if (group === "issue" && action === "show") {
      const issueID = resourceID(args, "issue", "issue");
      const detail = value(args, "issue-version") ? await module.showIssueVersion(issueID, integerValue(args, "issue-version", 1)) : await module.showIssue(issueID);
      if (!detail.issue.target_branch) return detail;
      const revision = value(args, "issue-version") ? (await module.contractIssue(issueID, integerValue(args, "issue-version", 1))).revision : await module.currentIssueRevision(issueID);
      const hint = await preflightService().issueHint(revision.id, detail.repository.id);
      return { ...detail, board: { ...detail.board, preflight: hint } };
    }
    if (group === "devrun" && action === "inspect-workspace") {
      const detail = await module.loadIssue(resourceID(args, "issue", "issue"));
      const repository = await resolveCurrentRepository(module, args, cwd);
      if (repository.id !== detail.repository.id) throw validation("workspace", "Issue Repository mismatch");
      return { result_type: "patchledger.result.workspace-input/v1", command: "devrun.inspect-workspace", workspace: previewExternalWorkspace(resolve(cwd, required(args, "directory")), detail.baseline.git_oid, repository.canonical) };
    }
    if (group === "devrun" && action === "plan") {
      const repository = await resolveCurrentRepository(module, args, cwd);
      const identity: DevelopmentIdentity = { format: "grounds.development-branch/v1", workspace_id: operationID(args, io), branch: "" };
      identity.branch = hasOption(args, "branch") ? required(args, "branch") : developmentBranchName(required(args, "issue-slug"), identity.workspace_id);
      const root = commonRepositoryRoot(cwd), definition = resolveBaseline(cwd, required(args, "definition-commit"));
      const target = { remote: required(args, "target-remote"), ref: required(args, "target-branch") };
      const observation = observeBranch(cwd, target, [repository.canonical], bool(args, "refresh"));
      if (!observation.commit || (bool(args, "refresh") && !observation.refreshed)) throw worktreeMismatch("", "target could not be observed; retain existing plan and do not claim latest remote state");
      const plan = createDevelopmentPlan(root, { ...identity, database_id: opened.config.database.expected_database_id, repository_id: repository.id,
        definition_commit: definition, target, path: developmentPath(root, identity), observed_at: observation.observed_at,
        observation: observation.refreshed ? "refreshed" : "local_tracking", status: "planned" });
      return { result_type: "grounds.result.development-plan/v1", command: "devrun.plan", plan, target_observation: observation, git_created: false };
    }
    if (group === "devrun" && (action === "start" || (action === "prepare" && hasOption(args, "issue")))) {
      // `devrun prepare --issue ... --plan ... [--refines-candidate ...]` creates
      // the recovery/sync scene for a new round (a refinement or a continuation)
      // WITHOUT starting substantive development: it never requires admission,
      // records a preparation, and leaves the DevRun in `preparing` until an
      // explicit admit. `devrun prepare --dev-run` (below) annotates an existing
      // open run instead.
      const prepareOnly = action === "prepare";
      const issueID = resourceID(args, "issue", "issue"), op = operationID(args, io);
      const previousStart = await opened.store.read(tx => tx.getOperation(op));
      const previousContext = previousStart?.command === "devrun.start" ? JSON.parse(previousStart.result_json).data.context : undefined;
      const devWorktrees = new DevWorktreeModule(cwd, opened.config.database.expected_database_id, newUUIDv7, opened.store);
      const recovery = devWorktrees.startRecovery(op);
      const originalRun = previousContext?.issue.id === issueID ? await opened.store.read(tx => tx.getDevRun(previousContext.dev_run.id)) : recovery ? await opened.store.read(tx => tx.getDevRun(recovery.dev_run_id)).catch(error => { if (error instanceof DomainError && error.code === "NOT_FOUND") return undefined; throw error; }) : undefined;
      const executionMode = originalRun ? originalRun.execution_mode : await selectDevelopmentMode(args, io, opened.config);
      if (originalRun && hasOption(args, "development-mode")) {
        if (!executionMode) throw validation("development-mode", "historical DevRun has no recorded mode; start a new DevRun to select one");
        resumeDevelopmentMode(executionMode.mode, value(args, "development-mode"));
      }
      const detail = await module.loadIssue(issueID, originalRun?.issue_revision_id ?? recovery?.issue_revision_id); const repository = await resolveCurrentRepository(module, args, cwd);
      if (previousContext && previousContext.repository.id !== repository.id) throw validation("repository", "original start operation belongs to another Repository");
      const brief = explorationBriefFor(args);
      const hasRefinement = hasOption(args, "refines-candidate");
      const refinement = value(args, "refines-candidate");
      if (hasRefinement && !refinement) throw validation("refines-candidate", "must not be empty");
      const refinementMaterialization = hasRefinement ? await module.loadCandidateMaterialization(refinement) : undefined;
      if (refinementMaterialization && refinementMaterialization.issue_revision_id !== detail.issue_revision.id) throw validation("refines-candidate", "parent Candidate must belong to the current Issue Version");
      if (refinementMaterialization && refinementMaterialization.repository_id !== repository.id) throw validation("refines-candidate", "parent Candidate must belong to the selected Repository");
      const targetBranch = detail.issue_revision.target_branch;
      if (prepareOnly && !targetBranch) throw validation("issue", "preparation is for a declared target flow");
      if (targetBranch && bool(args, "legacy-fixed") && !previousContext && !recovery) throw validation("legacy-fixed", "cannot create a new target-flow compatibility bypass; use a confirmed plan and preflight");
      if (!prepareOnly && targetBranch && refinementMaterialization && !previousContext && !recovery) throw validation("refines-candidate", "restore with devrun prepare, then admit the actual synchronized inputs");
      if (hasOption(args, "base-commit") && !targetBranch) throw validation("base-commit", "requires an Issue target branch");
      const baseCommit = hasOption(args, "base-commit") ? resolveBaseline(cwd, required(args, "base-commit")) : refinementMaterialization?.baseline.git_oid ?? detail.baseline.git_oid;
      if (refinementMaterialization && baseCommit !== refinementMaterialization.baseline.git_oid) throw validation("base-commit", "refinement must start at the parent Candidate base");
      if (targetBranch && !previousContext && !recovery) assertTargetBase(cwd, targetBranch, await module.repositoryRemotesForResolution(repository.canonical), baseCommit);
      if (hasOption(args, "input-digest") && !hasOption(args, "external-directory")) throw validation("input-digest", "requires external-directory");
      const external = hasOption(args, "external-directory") ? { directory: resolve(cwd, required(args, "external-directory")), remote: repository.canonical, ...(hasOption(args, "input-digest") ? { input_digest: required(args, "input-digest") } : {}) } : undefined;

      let plan: DevelopmentPlan | undefined, continueFrom: string | undefined;
      if (!hasOption(args, "plan") && recovery?.development) plan = readDevelopmentPlan(devWorktrees.repositoryRoot, recovery.development.workspace_id, opened.config.database.expected_database_id);
      if (hasOption(args, "plan")) plan = readDevelopmentPlan(devWorktrees.repositoryRoot, required(args, "plan"), opened.config.database.expected_database_id);
      if (refinementMaterialization && !bool(args, "parallel-route")) {
        const parent = await module.historyCandidate(refinementMaterialization.candidate_id);
        const local = devWorktrees.inspect(parent.record.candidate.dev_run_id);
        const parentRun = await module.showDevRun(parent.record.candidate.dev_run_id);
        const parentDevelopment = local.status === "available" ? local.development : local.status === "removed" ? parentRun.development : undefined;
        if (parentDevelopment) {
          const inherited = readDevelopmentPlan(devWorktrees.repositoryRoot, parentDevelopment.workspace_id, opened.config.database.expected_database_id);
          if (plan && plan.workspace_id !== inherited.workspace_id) throw validation("plan", "serial refinement must reuse its original plan; use --parallel-route for another route");
          plan = inherited; continueFrom = parent.record.candidate.dev_run_id;
        }
      }
      if (plan && (!targetBranch || plan.repository_id !== repository.id || JSON.stringify(plan.target) !== JSON.stringify(targetBranch) || plan.definition_commit !== detail.baseline.git_oid)) throw validation("plan", "confirmed plan Repository, target or definition commit differs from the sealed contract; show the difference and confirm a new plan");
      if (plan && external) throw validation("external-directory", "managed branch mode cannot bind an external activity directory");
      if (bool(args, "legacy-fixed") && plan) throw validation("legacy-fixed", "cannot be combined with a managed branch plan");
      if (targetBranch && !plan && !bool(args, "legacy-fixed") && recovery?.mode !== "legacy" && !(previousContext && !previousContext.dev_run.development)) throw validation("plan", "target-flow start requires a confirmed local plan (or the original managed parent route); no detached fallback is created");
      // A new target-flow start (not a replay or recovery) must already hold an
      // applicable observation+assessment bound to this exact base. A target
      // Issue cannot bypass the gate via the compatibility flag; no-target
      // Issues and pinned-start evaluation keep their original semantics.
      // A prepare-only round never requires admission here: it only builds the
      // scene, and admission is required before substantive development.
      if (!prepareOnly && targetBranch && !previousContext) {
        await preflightCoordinator.start({ issue_revision_id: detail.issue_revision.id, repository_id: repository.id, expected_commit: baseCommit, what: "start", operation_id: op });
      }
      const development = plan ? { format: plan.format, workspace_id: plan.workspace_id, branch: plan.branch } : undefined;
      if (previousContext && !recovery) {
        const replay = await module.startDevRun({ ...(executionMode ? { execution_mode: executionMode } : {}), ...(prepareOnly ? { prepare_only: true } : {}), ...(development ? { development } : {}), ...(targetBranch ? { base_commit: baseCommit } : {}), operation_id: op, dev_run_id: previousContext.dev_run.id, issue_id: issueID, issue_revision_id: detail.issue_revision.id, issue_revision_explicit: false, repository_remote_snapshot: previousContext?.repository.canonical_remote ?? repository.canonical, ...(brief === undefined ? {} : { exploration_brief: brief }), ...(hasRefinement ? { refines_candidate_id: refinement } : {}), attribution: actor() });
        return { ...replay.result, local_worktree: devWorktrees.inspect(replay.result.context.dev_run.id), warnings: replay.warnings };
      }
      const started = await devWorktrees.start({ ...(plan ? { development_plan: plan, ...(continueFrom ? { continue_from_run: continueFrom } : {}) } : {}), operation_id: op, repository_id: repository.id, issue_revision_id: detail.issue_revision.id, baseline_oid: baseCommit, ...(external ? { external_workspace: external } : {}), ...(refinementMaterialization ? { refinement: { candidate_id: refinementMaterialization.candidate_id, result_tree_oid: refinementMaterialization.result_tree_oid, patch: refinementMaterialization.patch, ...(refinementMaterialization.git_artifact ? { source_commit: refinementMaterialization.git_artifact.binding.source_commit, source_parents: refinementMaterialization.git_artifact.binding.ordered_parents } : {}) } } : {}) }, async (devRunID) => {
        const value = await module.startDevRun({ ...(executionMode ? { execution_mode: executionMode } : {}), ...(prepareOnly ? { prepare_only: true } : {}), ...(development ? { development } : {}), ...(targetBranch ? { base_commit: baseCommit } : {}), operation_id: op, dev_run_id: devRunID, issue_id: issueID, issue_revision_id: detail.issue_revision.id, issue_revision_explicit: false, repository_remote_snapshot: previousContext?.repository.canonical_remote ?? repository.canonical, ...(brief === undefined ? {} : { exploration_brief: brief }), ...(hasRefinement ? { refines_candidate_id: refinement } : {}), attribution: actor() });
        return { value, dev_run_id: value.result.context.dev_run.id };
      });
      return { ...started.value.result, local_worktree: started.local_worktree, ...(prepareOnly ? { prepare_only: true } : {}), warnings: started.value.warnings };
    }
    if (group === "devrun" && ["sync-status", "sync-show", "sync", "sync-complete", "sync-abandon"].includes(action)) {
      let sync = new DevRunSyncService(opened.store, new DevWorktreeModule(cwd, opened.config.database.expected_database_id, newUUIDv7, opened.store));
      if (action !== "sync-show") {
        const runId = ["sync", "sync-status"].includes(action) ? resourceID(args, "dev-run", "dev_run")
          : (await sync.show(resourceID(args, "sync", "sync"))).parent_id!;
        if (await new CodeWorkspaceRoutes(opened.store).forDevRun(runId))
          sync = new DevRunSyncService(opened.store, new CodeRouteSyncWorkspace(opened.store, cwd));
      }
      const header = { result_type: "patchledger.result.devrun-sync/v1", command: `devrun.${action}` };
      if (action === "sync-status") return { ...header, status: await sync.status(resourceID(args, "dev-run", "dev_run"), bool(args, "refresh")) };
      if (action === "sync-show") return { ...header, sync: await sync.show(resourceID(args, "sync", "sync")) };
      const who = { operation_id: operationID(args, io), attribution: actor() };
      const version = integerValue(args, "expected-version", 1);
      if (action === "sync") return { ...header, sync: await sync.start(resourceID(args, "dev-run", "dev_run"), version, required(args, "target-commit"), bool(args, "refresh"), who, hasOption(args, "expected-head") ? resolveBaseline(cwd, required(args, "expected-head")) : undefined) };
      if (action === "sync-abandon") return { ...header, sync: await sync.abandon(resourceID(args, "sync", "sync"), version, who) };
      let decisions: Array<{ path: string; explanation: string }> = [];
      if (hasOption(args, "file")) {
        try { decisions = JSON.parse(safeRead(resolve(cwd, required(args, "file")), 1024 * 1024).toString("utf8")); }
        catch { throw validation("file", "requires a readable bounded JSON array of conflict decisions"); }
      }
      if (!Array.isArray(decisions)) throw validation("file", "requires a JSON array of conflict decisions");
      return { ...header, sync: await sync.complete(resourceID(args, "sync", "sync"), version, decisions, who) };
    }
    if (group === "devrun" && action === "context") {
      const runID = resourceID(args, "dev-run", "dev_run");
      const result = await module.devRunContext(runID, false, commaSeparated(args, "include-verification"));
      const local = (await observeCodeRoute(opened.store, runID))?.view
        ?? await new DevWorktreeModule(cwd, opened.config.database.expected_database_id, newUUIDv7, opened.store).inspectAuthoritative(runID);
      return { ...result, local_worktree: local.status === "available" && result.context.dev_run.development && JSON.stringify(local.development) !== JSON.stringify(result.context.dev_run.development) ? { status: "invalid", reason: "local development identity differs from the ledger" } : local };
    }
    if (group === "devrun" && action === "abandon") {
      const runID = resourceID(args, "dev-run", "dev_run");
      const routes = new CodeWorkspaceRoutes(opened.store), route = await routes.forDevRun(runID);
      if (route) return routes.abandon(route.route_id, runID, cwd, () => module.abandonDevRun({
        operation_id: operationID(args, io), dev_run_id: runID, expected_version: integerValue(args, "expected-version", 1),
        ...(hasOption(args, "reason") ? { reason: value(args, "reason") } : {}), attribution: actor() }));
      const observed = new DevWorktreeModule(cwd, opened.config.database.expected_database_id, newUUIDv7).observe(runID);
      if (["syncing", "sync_interrupted"].includes(observed.journal?.lifecycle ?? "")) throw runtimeError("complete or abandon sync before abandoning the DevRun");
      if (routeLeased(cwd, opened.config.database.expected_database_id, runID)) throw runtimeError('the route is leased or requires reconciliation; wait for it to finish or repair the route before abandoning');
      const reminder = await uncommittedReminder(module, opened.config.database.expected_database_id, cwd, runID);
      const result = await module.abandonDevRun({ operation_id: operationID(args, io), dev_run_id: runID, expected_version: integerValue(args, "expected-version", 1), ...(hasOption(args, "reason") ? { reason: value(args, "reason") } : {}), attribution: actor() });
      await new DevWorktreeModule(cwd, opened.config.database.expected_database_id, newUUIDv7).markAbandoned(runID);
      return reminder ? { ...result, warnings: [reminder.warning] } : result;
    }
    if (group === "devrun" && action === "continue") {
      const run = required(args, "dev-run"), expectedHead = resolveBaseline(cwd, required(args, "expected-head"));
      const policy = required(args, "policy") as "parallel" | "paused";
      const who = actor(), op = operationID(args, io);
      return new DevWorktreeModule(cwd, opened.config.database.expected_database_id, newUUIDv7, opened.store).continuation(run, expectedHead, policy, () => module.recordDevelopmentContinuation({ operation_id: op, dev_run_id: run, expected_version: integerValue(args, "expected-version", 1), expected_head: expectedHead, policy, attribution: who }));
    }
    if (group === "devrun" && action === "cleanup") {
      const runID = resourceID(args, "dev-run", "dev_run");
      const workspace = await observeCodeRoute(opened.store, runID);
      if (workspace) {
        if (bool(args, "preview")) return { result_type: "grounds.result.development-cleanup-preview/v1", command: "devrun.cleanup",
          preview: { dev_run_id: runID, local_worktree: workspace.view, options: ["keep"],
            risks: ["Workspace-owned route: use code-workspace end and code-workspace cleanup for lifecycle checks"] } };
        if (value(args, "choice") === "keep") return { result_type: "patchledger.result.devrun-worktree-cleanup/v1", command: "devrun.cleanup",
          dev_run_id: runID, removed: false, local_worktree: workspace.view };
        throw runtimeError("Workspace-owned route: use code-workspace end and code-workspace cleanup for lifecycle checks");
      }
      const preview = new DevWorktreeModule(cwd, opened.config.database.expected_database_id, newUUIDv7, opened.store).cleanupPreview(runID);
      const leased = routeLeased(cwd, opened.config.database.expected_database_id, runID);
      if (leased) preview.risks.push("the route is leased or its Git pointer is damaged");
      if (bool(args, "preview")) return { result_type: "grounds.result.development-cleanup-preview/v1", command: "devrun.cleanup", preview };
      if (leased) throw runtimeError('the route is leased or requires reconciliation; wait for it to finish or repair the route before cleanup');
      const run = await module.showDevRun(runID);
      const resultTree = run.state === "submitted" ? await module.submittedResultTree(runID) : undefined;
      const operation = operationID(args, io);
      const cleanupResult = (fields: Record<string, unknown>) => ({ result_type: "patchledger.result.devrun-worktree-cleanup/v1", command: "devrun.cleanup", dev_run_id: runID, ...fields });
      const replayed = await module.completedDevRunWorktreeRemoval(operation, runID);
      if (replayed && value(args, "choice") !== "worktree-and-branch") return cleanupResult({ removed: true, local_worktree: { status: "removed" }, deletion_summary: replayed });
      const reminder = await uncommittedReminder(module, opened.config.database.expected_database_id, cwd, runID);
      const worktrees = new DevWorktreeModule(cwd, opened.config.database.expected_database_id, newUUIDv7, opened.store);
      let cleaned;
      try { cleaned = await worktrees.cleanup(runID, run.state, bool(args, "discard-changes"), resultTree, { operation_id: operation, attribution: actor() }, (value(args, "choice") || "worktree") as "worktree" | "worktree-and-branch" | "keep"); }
      catch (error) {
        // Same error code and structure; the message only gains the local-work summary.
        if (reminder && error instanceof DomainError && error.code === "WORKTREE_MISMATCH") throw new DomainError(error.code, `${error.message}; ${reminder.summary}`, error.retryable, error.details);
        throw error;
      }
      const { removal, ...outcome } = cleaned;
      // The files are already gone when this runs; a failure here leaves the local receipt so a retry records the same event.
      const deletion = removal ? await module.recordDevRunWorktreeRemoval(removal) : undefined;
      if (removal) worktrees.markRemovalRecorded(runID, removal.operation_id);
      return cleanupResult({ ...outcome, ...(deletion ? { deletion_summary: deletion } : {}), ...(reminder ? { warnings: [reminder.warning] } : {}) });
    }
    if (group === "devrun" && action === "list") return module.listDevRuns(value(args, "issue"), { ...(hasOption(args, "issue-version") ? { issue_version: integerValue(args, "issue-version", 1) } : {}), ...(hasOption(args, "repository") ? { repository_id: value(args, "repository") } : {}), ...(hasOption(args, "state") ? { state: value(args, "state") } : {}) }, pageRequest(args));
    if (group === "devrun" && action === "show") {
      const runID = resourceID(args, "dev-run", "dev_run"), detail = await module.showDevRun(runID);
      const preflight = await preflightService().devRunReadModel(runID);
      if (!detail.development) return { ...detail, ...(preflight ? { preflight } : {}) };
      const local = (await observeCodeRoute(opened.store, runID))?.view
        ?? await new DevWorktreeModule(cwd, opened.config.database.expected_database_id, newUUIDv7, opened.store).inspectAuthoritative(runID);
      const current = local.status === "available" && local.head && local.active_dev_run_id && local.owner_phase === "active" ? await module.developmentHeadStanding(local.active_dev_run_id, local.head) : { standing: "unknown" };
      return { ...detail, local_worktree: local, current_head: current, ...(preflight ? { preflight } : {}) };
    }
    if (group === "devrun" && action === "reconcile") return reconcileDevRun(module, opened.config.database.expected_database_id, cwd, resourceID(args, "dev-run", "dev_run"),
      await observeCodeRoute(opened.store, resourceID(args, "dev-run", "dev_run")));
    if (group === "devrun" && action === "uncommitted") return listUncommittedWork(module, opened.config.database.expected_database_id, cwd);
    if (group === "candidate" && action === "diff") {
      const candidateId = resourceID(args, "candidate", "candidate"), descriptor = await module.candidateArtifactDescriptor(candidateId);
      if (!descriptor.source || !descriptor.repository_id) throw validation("candidate", "A fixed Git source is required; historical patch-only Candidates are unsupported");
      await validateRepositoryClone(module, cwd, descriptor.repository_id);
      const repository = await module.showRepository(descriptor.repository_id);
      const history = await opened.store.read(async tx => {
        const ref = (await tx.findCandidateArtifactRef({candidate_id: candidateId}))!;
        const run = await tx.getDevRun(ref.dev_run_id);
        return candidateHistoryProjection(tx, {candidate: {id: candidateId, issue_revision_id: ref.issue_revision_id, dev_run_id: ref.dev_run_id}, refines_candidate_id: run.refines_candidate_id});
      });
      const binding = descriptor.git_artifact?.binding ?? {repository_id: descriptor.repository_id, canonical_remote: repository.canonical_remote, archive_ref: `refs/tags/grounds/candidates/${candidateId}`, source_commit: descriptor.source.commit, ordered_parents: descriptor.source.parents, result_tree: descriptor.result_tree_oid, base_commit: descriptor.base_commit};
      const view = hasOption(args, "view") ? required(args, "view") : "candidate";
      let left = descriptor.base_commit, right = descriptor.source.commit;
      let purpose: Parameters<typeof candidateDiff>[0]["purpose"] = "candidate_changes";
      if (view === "original") {
        let rootId = candidateId, parent = history.lineage.refines_candidate_id;
        while (parent) {rootId = parent; parent = (await module.candidateLineage(parent)).lineage.refines_candidate_id;}
        const original = await module.candidateArtifactDescriptor(rootId);
        if (!original.source) throw validation("candidate", "Original Candidate source history is unknown");
        left = original.base_commit; right = original.source.commit; purpose = "original_changes";
      } else if (view === "upstream" || view === "cumulative") {
        if (!history.lineage.initial_base_commit) throw validation("candidate", "Original development baseline is unknown");
        left = history.lineage.initial_base_commit; right = view === "upstream" ? descriptor.base_commit : descriptor.source.commit;
        purpose = view === "upstream" ? "upstream_changes" : "cumulative_changes";
      } else if (view === "evolution") {
        if (!history.lineage.refines_candidate_id) throw validation("candidate", "This Candidate has no refinement predecessor");
        const previous = await module.candidateArtifactDescriptor(history.lineage.refines_candidate_id);
        if (!previous.source) throw validation("candidate", "Predecessor source history is unknown");
        left = previous.source.commit; purpose = "candidate_evolution";
      } else if (view === "landing") {
        const recordId = required(args, "landing-record");
        const record = history.adoption.find(item => item.id === recordId), landed = record?.landing?.actual_landing;
        const predecessor = record?.landing?.target_predecessor;
        if (!landed || predecessor?.state !== "confirmed" || !predecessor.commit) throw new DomainError("STATE_CONFLICT", "Actual target predecessor evidence is missing or conflicting; preserve the adoption fact and provide a separately identified observation with exact predecessor evidence", false, {candidate_id: candidateId, landing_record_id: recordId, reason: predecessor?.state === "conflict" ? "actual_target_predecessor_conflict" : "actual_target_predecessor_unknown"});
        left = predecessor.commit.oid; right = landed.oid; purpose = "landing_changes";
      } else if (view === "target") {
        left = required(args, "target-commit"); purpose = "target_observation";
        required(args, "observation-time");
      } else if (view !== "candidate") throw validation("view", "Unsupported fixed comparison view");
      if (view !== "target" && (hasOption(args, "target-commit") || hasOption(args, "observation-time"))) throw validation("view", "Observed-target inputs require view=target");
      if (view !== "landing" && hasOption(args, "landing-record")) throw validation("view", "landing-record requires view=landing");
      const comparison = candidateDiff({repositoryPath: cwd, binding, left_commit: left, right_commit: right, purpose, ...(view === "target" ? {observed_at: required(args, "observation-time")} : {})});
      return {result_type: "grounds.result.candidate-diff/v1", command: "candidate.diff", candidate_id: candidateId, view, comparison};
    }
    if (group === "candidate" && action === "lineage") return module.candidateLineage(resourceID(args, "candidate", "candidate"));
    if (group === "candidate" && action === "archive-operation") {
      const operation = await new CandidateArchiveService(opened.store, cwd).show(required(args, "operation-id"));
      return { result_type: "grounds.result.candidate-archive-operation/v1", command: "candidate.archive-operation", operation, next_action: archiveOperation(operation).phase === "committed" ? "none" : archiveOperation(operation).phase === "failed" ? "resolve_identity_conflict" : "retry_original_operation" };
    }
    if (group === "candidate" && ["archive-status", "fetch", "restore", "archive"].includes(action)) {
      const candidateId = resourceID(args, "candidate", "candidate");
      const ref = await opened.store.read(tx => tx.findCandidateArtifactRef({ candidate_id: candidateId }));
      if (!ref) throw new DomainError("NOT_FOUND", "Candidate not found");
      const archives = new CandidateArchiveService(opened.store, cwd);
      if (action === "archive-status") {
        const rows = [...await opened.store.read(tx => tx.listRuntimeRecords("runtime_operation", ref.dev_run_id)), ...await opened.store.read(tx => tx.listRuntimeRecords("runtime_operation", candidateId))];
        const history = rows.filter(row => row.data.format === "grounds.candidate-archive-operation/v1").map(archiveOperation).filter(op => op.candidate_id === candidateId);
        const artifact = ref.git_artifact;
        return { result_type: "grounds.result.candidate-archive-status/v1", command: "candidate.archive-status", candidate_id: candidateId,
          ...(artifact ? { artifact, local_availability: inspectLocalGitArchive(cwd, artifact.binding), ...(bool(args, "refresh") ? { remote_observation: inspectGitArchive({ binding: artifact.binding }) } : {}) } : {}),
          remote_check: bool(args, "refresh") && artifact ? "observed" : "not_requested", archive_history: history };
      }
      if (action === "fetch" || action === "restore") {
        if (!ref.git_artifact) throw validation("candidate", "Candidate requires a confirmed Git archive; historical patch-only restoration is unsupported");
        await validateRepositoryClone(module, cwd, ref.git_artifact.binding.repository_id);
        const observation = action === "fetch" ? fetchGitArchive(cwd, ref.git_artifact.binding) : restoreGitArchive({ binding: ref.git_artifact.binding, destination: resolve(cwd, required(args, "path")), ...(hasOption(args, "branch") ? { branch: required(args, "branch") } : {}) });
        if (observation.status !== "confirmed") throw new DomainError("STATE_CONFLICT", "Fixed archive could not be fetched or restored; existing work was preserved", false, { candidate_id: candidateId, reason: observation.reason ?? observation.status });
        return { result_type: `grounds.result.candidate-${action}/v1`, command: `candidate.${action}`, candidate_id: candidateId, observation, ...(action === "restore" ? { target_path: resolve(cwd, required(args, "path")), source_commit: ref.git_artifact.binding.source_commit } : {}) };
      }
      // Re-observe an existing supported Git Candidate without changing its fixed identity.
      const descriptor = await module.candidateArtifactDescriptor(candidateId);
      if (!descriptor.source || !descriptor.repository_id) {
        if (!bool(args, "dry-run")) throw validation("candidate", "No original source identity exists; code-only recovery cannot be relabelled as original history");
        return { result_type: "grounds.result.candidate-archive/v1", command: "candidate.archive", candidate_id: candidateId, dry_run: true, eligible: false, reason: "source_history_not_recorded" };
      }
      await validateRepositoryClone(module, cwd, descriptor.repository_id);
      const repository = await module.showRepository(descriptor.repository_id);
      const makeBinding = () => collectGitArchiveBinding(cwd, { repository_id: descriptor.repository_id!, canonical_remote: repository.canonical_remote, archive_ref: `refs/tags/grounds/candidates/${candidateId}`, source_commit: descriptor.source!.commit, base_commit: descriptor.base_commit });
      if (bool(args, "dry-run")) {
        const binding = makeBinding();
        try {
          const policy_check = { status: "confirmed", protection: await archivePolicyFor(opened.store, cwd, value(args, "archive-policy"))(binding, new Date().toISOString()) };
          return { result_type: "grounds.result.candidate-archive/v1", command: "candidate.archive", candidate_id: candidateId, dry_run: true, eligible: true, binding, policy_check };
        } catch (error) {
          if (error instanceof ArchiveProtectionUnavailable) throw new DomainError("STATE_CONFLICT", "Archive protection could not be confirmed; resolve the project diagnosis and recheck", false, { protection_diagnosis: error.diagnosis });
          throw error;
        }
      }
      const policyCheck = archivePolicyFor(opened.store, cwd, value(args, "archive-policy")), operationId = operationID(args, io);
      await archives.prepare({ operation_id: operationId, purpose: "candidate_backfill", owner_id: candidateId, candidate_id: candidateId, request: { patch_digest: ref.patch_digest, source: descriptor.source }, binding: makeBinding, attribution: actor() });
      const verified = await archives.verify(operationId, policyCheck);
      const artifact = await opened.store.write(tx => tx.putCandidateGitArtifact(candidateId, verified.artifact));
      const operation = await archives.committed(operationId, { candidate_id: candidateId, artifact });
      return { result_type: "grounds.result.candidate-archive/v1", command: "candidate.archive", candidate_id: candidateId, dry_run: false, eligible: true, artifact, operation };
    }
    if (group === "candidate" && action === "submit") {
      const runID = resourceID(args, "dev-run", "dev_run");
      const routes = new CodeWorkspaceRoutes(opened.store), route = await routes.forDevRun(runID);
      if (!route && routeLeased(cwd, opened.config.database.expected_database_id, runID)) throw runtimeError('the route is leased or requires reconciliation; wait for it to finish or repair the route first');
      const op = operationID(args, io);
      const expectedVersion = integerValue(args, "expected-version", 1);
      const submitter = actor();
      const submission = decodeCandidateSubmissionFile(required(args, "file"));
      const languageWarnings = checkContentLanguage(candidateProse(submission), contentLanguagePolicy(hasOption(args, "content-language") ? value(args, "content-language") : undefined, hasOption(args, "language-override-reason") ? value(args, "language-override-reason") : undefined));
      // Candidate artifacts are part of the canonical idempotency request.
      // Re-capture on every retry so a reused operation ID cannot silently
      // accept a different worktree state; the Module then replays or reports
      // IDEMPOTENCY_CONFLICT from the complete artifact hash.
      const devWorktrees = new DevWorktreeModule(cwd, opened.config.database.expected_database_id, newUUIDv7, opened.store);
      const replay = await module.replayCandidateSubmit(op, { dev_run_id: runID, expected_version: expectedVersion, submission, attribution: submitter });
      const capture = async (devCwd: string) => {
        if (!replay.found) await module.assertDevelopmentAdmission(runID);
        const context = await module.candidateSubmitContext(runID);
        const baseCommit = context.context.base_commit ?? context.context.baseline.git_oid;
        if (context.context.base_commit && context.context.issue.target_branch) assertTargetBase(devCwd, context.context.issue.target_branch, await module.repositoryRemotesForResolution(context.context.repository.canonical_remote), baseCommit);
        if (context.context.dev_run.development) await validateRepositoryClone(module, devCwd, context.context.repository.id);
        else await validateRepositoryClone(module, devCwd, context.context.repository.id);
        const local = route ? undefined : devWorktrees.inspect(runID);
        const development = route?.development ?? (local?.status === "available" ? local.development : undefined);
        const fixed = development ? captureCommittedDevelopment(devCwd, development, baseCommit, route ? "external-runtime" : true) : captureCommittedCandidate(devCwd, baseCommit);
        const artifact = fixed.artifact;
        // Pin the source before crossing SQL; a crash retains an operation-scoped object.
        retainCandidateSource(devCwd, op, fixed.source);
        let result;
        {
          const policyCheck = archivePolicyFor(opened.store, cwd, value(args, "archive-policy"));
          const archives = new CandidateArchiveService(opened.store, devCwd);
          const row = await archives.prepare({ operation_id: op, purpose: "candidate_submit", owner_id: runID, request: { expected_version: expectedVersion, submission, patch_digest: artifact.patch_digest, result_tree_oid: artifact.result_tree_oid }, attribution: submitter,
            binding: candidate => collectGitArchiveBinding(devCwd, { repository_id: context.context.repository.id, canonical_remote: context.context.repository.canonical_remote, archive_ref: `refs/tags/grounds/candidates/${candidate}`, source_commit: fixed.source.commit, base_commit: baseCommit }) });
          const verified = await archives.verify(op, policyCheck);
          result = await module.submitCandidate({ candidate_id: archiveOperation(row).candidate_id, git_artifact: verified.artifact, operation_id: op, dev_run_id: runID, expected_version: expectedVersion, submission, artifact, source: fixed.source, attribution: submitter });
          await archives.committed(op, result);
          retainCandidateSource(devCwd, result.candidate_id, fixed.source);
        }
        return result;
      };
      const submitted = route
        ? await routes.captureCandidate(route.route_id, runID, cwd, replay.found, capture)
        : await devWorktrees.submit(runID, capture);
      return { ...submitted, warnings: languageWarnings };
    }
    if (group === "completion") {
      const issue = required(args, "issue"), version = integerValue(args, "issue-version", 1);
      if (action === "show") return module.showCompletion(issue, version);
      const input = { issue_id: issue, issue_version: version, expected_version: integerValue(args, "expected-version", 0), operation_id: operationID(args, io), attribution: attribution(args, cwd) };
      if (action === "reopen") return module.reopenCompletion({ ...input, reason: required(args, "reason") });
      let completion: CompletionInput;
      try { completion = JSON.parse(decodeFile(resolve(cwd, required(args, "file"))).toString("utf8")) as CompletionInput; }
      catch { throw validation("file", "requires readable completion input JSON"); }
      return module.recordCompletion({ ...input, completion });
    }
    if (group === "selection") {
      const issueId = required(args, "issue");
      const parseVersion = (key: string, minimum: number): number => {
        const raw = required(args, key);
        const number = Number(raw);
        if (!/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(number) || number < minimum || number > 2147483646) throw validation(key, `must be an integer between ${minimum} and 2147483646`);
        return number;
      };
      if (action === "show") return module.showSelection(issueId, hasOption(args, "issue-version") ? parseVersion("issue-version", 1) : undefined);
      if (action === "inspect") {
        if (hasOption(args, "path") && (!value(args, "path").trim() || [...resolve(cwd, value(args, "path"))].length > 32768)) throw validation("path", "must be nonempty and at most 32768 characters");
        const selection = await module.showSelection(issueId, hasOption(args, "issue-version") ? parseVersion("issue-version", 1) : undefined);
        const detail = await module.showIssue(issueId);
        await validateRepositoryClone(module, cwd, detail.repository.id);
        const worktrees = new DeliveryWorktreeModule(cwd, opened.config.database.expected_database_id).inspect(selection, hasOption(args, "path") ? value(args, "path") : undefined);
        for (const item of worktrees) if (item.recommended_argv.length) item.recommended_argv.push("--config", configPath(value(args, "config")));
        return { result_type: "patchledger.result.selection-inspect/v1", command: "selection.inspect", issue: selection.issue, selection: selection.selection, discovery_scope: "current_clone", worktrees };
      }
      const issueVersion = parseVersion("issue-version", 1);
      const expectedVersion = parseVersion("expected-version", 0);
      if (action === "set" || action === "clear") {
        const input = { issue_id: issueId, issue_version: issueVersion, expected_version: expectedVersion, operation_id: operationID(args, io), attribution: attribution(args, cwd), ...(hasOption(args, "reason") ? { reason: value(args, "reason") } : {}) };
        return action === "set" ? module.setSelection({ ...input, candidate_id: required(args, "candidate") }) : module.clearSelection(input);
      }
      const path = required(args, "path");
      if (!path.trim() || [...resolve(cwd, path)].length > 32768) throw validation("path", "must be nonempty and at most 32768 characters");
      if (hasOption(args, "branch") && !value(args, "branch").trim()) throw validation("branch", "must not be empty");
      try {
        const initial = await module.loadSelectionMaterialization(issueId, issueVersion, expectedVersion);
        await validateRepositoryClone(module, cwd, initial.materialization.repository_id);
        const branch = value(args, "branch") || `grounds/candidate/${initial.materialization.candidate_id}`;
        return await new DeliveryWorktreeModule(cwd, opened.config.database.expected_database_id).prepare(path, branch, async () => {
          const { selection, materialization } = await module.loadSelectionMaterialization(issueId, issueVersion, expectedVersion);
          let decision: string | undefined, observedTarget: string | undefined;
          const detail = await module.showIssueVersion(issueId, issueVersion), target = detail.issue.target_branch;
          const managed = await opened.store.read(async tx => {
            const ref = await tx.findCandidateArtifactRef({ candidate_id: materialization.candidate_id });
            return !!(ref && (await tx.getDevRun(ref.dev_run_id)).development);
          });
          if (managed && !target) throw validation("target", "managed Candidate requires its fixed contract target");
          if (materialization.source && target) {
            const observation = observeBranch(cwd, target, [materialization.canonical_remote], true);
            if (!observation.refreshed || !observation.commit) throw worktreeMismatch(materialization.candidate_id, "target refresh failed; delivery remains unknown");
            observedTarget = observation.commit.oid;
            const relation = targetRelation(cwd, materialization.baseline.git_oid, observedTarget);
            if (!["equal", "advanced"].includes(relation) || inspectCandidateSource(cwd, materialization.candidate_id, materialization.source).status !== "present" || readCommit(cwd, materialization.source.commit).tree_oid !== materialization.result_tree_oid) throw worktreeMismatch(materialization.candidate_id, "target was rewritten/unknown or fixed source is missing/inconsistent; no unverified exception can waive these facts");
            const needsException = relation === "advanced" || selection.selection.current_verification?.standing !== "qualified";
            if (needsException && !bool(args, "allow-unverified")) throw new DomainError("STATE_CONFLICT", relation === "advanced" ? "target advanced; sync the managed route, archive a new Candidate and independently verify before preparing delivery" : "fixed delivery commit is unverified; pause for an explicit single preparation decision", false, { candidate_id: materialization.candidate_id, source_commit: materialization.source.commit, target_commit: observedTarget });
            // Explicit same-operation retries retain and revalidate an old decision even
            // after qualification. A new qualified/equal request creates no exception.
            if (bool(args, "allow-unverified")) {
              decision = await module.recordDeliveryException({ operation_id: required(args, "operation-id"), issue_id: issueId, issue_version: issueVersion, selection_id: selection.selection.id!, selection_version: selection.selection.version, candidate_id: materialization.candidate_id,
                source_commit: materialization.source.commit, target_commit: observedTarget, reason: required(args, "reason"), attribution: actor() }, !needsException);
            }
          }
          const receipt: DeliveryReceipt = {
            ...(observedTarget ? { observed_target_commit: observedTarget } : {}), ...(decision ? { delivery_decision_id: decision } : {}),
            format: materialization.source ? "grounds.delivery-worktree/v2" : "patchledger.delivery-worktree/v1", ...(materialization.source ? { source_commit: materialization.source.commit } : {}), database_id: opened.config.database.expected_database_id,
            issue: selection.issue, selection_id: selection.selection.id!, selection_version: selection.selection.version,
            candidate_id: materialization.candidate_id, repository_id: materialization.repository_id,
            baseline_oid: materialization.baseline.git_oid, patch_digest: materialization.patch_digest, result_tree_oid: materialization.result_tree_oid,
          };
          return { receipt, ...(materialization.source ? { source: materialization.source } : {}), patch: materialization.patch, warnings: selection.selection.warnings };
        });
      } catch (error) {
        if (error instanceof DomainError) { error.details.target_path = resolve(cwd, path); error.details.inspect_argv = ["selection", "inspect", "--issue", issueId, "--issue-version", String(issueVersion), "--path", resolve(cwd, path), "--cwd", cwd, "--config", configPath(value(args, "config"))]; }
        throw error;
      }
    }
    if (group === "candidate" && action === "materialize") {
      const candidateID = resourceID(args, "candidate", "candidate");
      const mode = value(args, "mode", "existing") as WorktreeMode;
      if (!(["existing", "review", "delivery"] as string[]).includes(mode)) throw validation("mode", "must be existing, review, or delivery");
      if (mode === "delivery" && args.values.path === undefined) throw validation("path", "is required in delivery mode");
      const branchOption = value(args, "branch");
      if (hasOption(args, "branch") && !branchOption.trim()) throw validation("branch", "must not be empty");
      let branch = branchOption;
      if (mode === "existing" && hasOption(args, "branch")) throw validation("branch", "is only valid in delivery mode");
      if (mode === "review" && branch !== "") throw validation("branch", "is only valid in delivery mode");
      if (mode === "delivery" && !branch) branch = `grounds/candidate/${candidateID}`;
      if (hasOption(args, "path") && !value(args, "path").trim()) throw validation("path", "must not be empty");
      const materialization = await module.loadCandidateMaterialization(candidateID);
      if (mode === "delivery") {
        const gated = await opened.store.read(async tx => {
          const ref = await tx.findCandidateArtifactRef({ candidate_id: candidateID });
          return !!(ref && ((await tx.getDevRun(ref.dev_run_id)).development || (await tx.getIssueRevisionById(ref.issue_revision_id)).target_branch));
        });
        if (gated) throw validation("mode", "target-bound Candidate delivery requires Selection and its refreshed target/source/Verification gate; use selection materialize");
      }
      // Review mode without --path gets a CLI-named session so verification material has one predictable home.
      const sessions = mode === "review" && args.values.path === undefined ? new ReviewSessions(commonRepositoryRoot(cwd)) : undefined;
      if (mode === "existing") await validateMaterializationTarget(module, resolve(value(args, "path", cwd)), materialization.repository_id, materialization.baseline.git_oid);
      else await validateRepositoryClone(module, cwd, materialization.repository_id);
      const session = sessions?.allocate(candidateID);
      const targetPath = session ? session.worktree : resolve(value(args, "path", cwd));
      const reviewMarker: ReviewWorktreeMarker | undefined = mode === "review" ? { format: "patchledger.review-worktree/v1", database_id: opened.config.database.expected_database_id, candidate_id: materialization.candidate_id, repository_id: materialization.repository_id, baseline_oid: materialization.baseline.git_oid, result_tree_oid: materialization.result_tree_oid, patch_digest: materialization.patch_digest } : undefined;
      let created;
      try { created = materializeCandidateWorktree({ source_path: cwd, target_path: targetPath, mode, ...(branch ? { branch } : {}), source_commit: materialization.source?.commit, baseline_oid: materialization.baseline.git_oid, patch: materialization.patch, expected_tree_oid: materialization.result_tree_oid, ...(reviewMarker ? { review_marker: reviewMarker } : {}) }); }
      catch (error) { if (session) sessions?.discard(session.directory); throw error; }
      return { result_type: "patchledger.result.candidate-materialize/v1", command: "candidate.materialize", candidate_id: materialization.candidate_id, result_tree_oid: materialization.result_tree_oid, target_path: created.target_path, materialization_mode: created.mode, ...(created.branch ? { branch: created.branch } : {}), ...(session ? { review_session_id: session.session_id } : {}) };
    }
    if (group === "candidate" && action === "artifact") {
      const { candidate_id, ...artifact } = await module.candidateArtifactDescriptor(resourceID(args, "candidate", "candidate"));
      let retention: ReturnType<typeof inspectCandidateSource> | undefined;
      if (artifact.source) {
        try { await validateRepositoryClone(module, cwd, artifact.repository_id!); retention = inspectCandidateSource(cwd, candidate_id, artifact.source, artifact.result_tree_oid); }
        catch { retention = { status: "unknown" }; }
      }
      return { result_type: "patchledger.result.candidate-artifact/v1", command: "candidate.artifact", candidate_id, artifact, ...(retention ? { source_retention: { scope: "current_clone", ...retention } } : {}) };
    }
    if (group === "candidate" && action === "replay-check") {
      const hasCandidate = hasOption(args, "candidate"), hasIssue = hasOption(args, "issue"), hasVersion = hasOption(args, "issue-version");
      if (hasCandidate && (hasIssue || hasVersion)) throw validation("candidate", "use either --candidate or --issue with --issue-version, not both");
      if (!hasCandidate && !(hasIssue && hasVersion)) throw validation(hasIssue ? "issue-version" : "candidate", "provide --candidate, or --issue together with --issue-version");
      const subject = await module.replaySubject(hasCandidate ? { candidate_id: required(args, "candidate") } : { issue_id: required(args, "issue"), issue_version: integerValue(args, "issue-version", 1) });
      await validateRepositoryClone(module, cwd, subject.repository_id);
      const { patch: _patch, registered_remotes: _remotes, repository_id: _repository, ...reference } = subject;
      return { result_type: "patchledger.result.candidate-replay-check/v1", command: "candidate.replay-check", ...reference, ...replayCheck(cwd, subject, { refresh: bool(args, "refresh") }) };
    }
    if (group === "candidate" && action === "show") return module.showCandidate(resourceID(args, "candidate", "candidate"), value(args, "manifest-cursor"), value(args, "verifications-cursor"));
    if (group === "candidate" && action === "list") {
      if (hasOption(args, "issue-version") && !value(args, "issue")) throw validation("issue-version", "requires --issue");
      const issueID = value(args, "issue");
      const filter = { ...(hasOption(args, "repository") ? { repository_id: value(args, "repository") } : {}), ...(hasOption(args, "standing") ? { standing: value(args, "standing") } : {}), ...(hasOption(args, "selected") ? { selected: optionalBoolean(args, "selected") } : {}) };
      return issueID ? module.listCandidatesForIssue(issueID, hasOption(args, "issue-version") ? integerValue(args, "issue-version", 1) : undefined, filter, pageRequest(args)) : module.listCandidates("", filter, pageRequest(args));
    }
    if (group === "candidate" && action === "compare") {
      const ids = [...commaSeparated(args, "candidate"), ...args.positionals.slice(2)];
      if (bool(args, "summary")) {
        if (hasOption(args, "include-patch") || hasOption(args, "pairwise")) throw validation("summary", "cannot be combined with --include-patch or --pairwise");
        return module.compareCandidateSummary(ids);
      }
      if (ids.length < 2) throw validation("candidate_ids", "must contain between 2 and 16 candidates");
      const pairwise = commaSeparated(args, "pairwise").map((pair, index) => {
        const separator = pair.indexOf(":");
        if (separator <= 0 || separator === pair.length - 1 || pair.indexOf(":", separator + 1) >= 0) throw validation(`pairwise[${index}]`, "must use left:right Candidate IDs");
        return [pair.slice(0, separator), pair.slice(separator + 1)] as [string, string];
      });
      const options: PairwiseOptions = { include_patch_ids: commaSeparated(args, "include-patch"), pairwise_pairs: pairwise };
      return module.compareCandidates(ids, options);
    }
    if (group === "candidate" && action === "template") {
      const runID = resourceID(args, "dev-run", "dev_run");
      const routes = new CodeWorkspaceRoutes(opened.store), route = await routes.forDevRun(runID);
      if (!route && routeLeased(cwd, opened.config.database.expected_database_id, runID)) throw runtimeError('the route is leased or requires reconciliation; wait for it to finish or repair the route first');
      const worktrees = new DevWorktreeModule(cwd, opened.config.database.expected_database_id, newUUIDv7, opened.store);
      const capture = async (path: string) => {
        await module.assertDevelopmentAdmission(runID);
        const context = await module.candidateSubmitContext(runID);
        const baseCommit = context.context.base_commit ?? context.context.baseline.git_oid;
        if (context.context.base_commit && context.context.issue.target_branch) assertTargetBase(path, context.context.issue.target_branch, await module.repositoryRemotesForResolution(context.context.repository.canonical_remote), baseCommit);
        await validateRepositoryClone(module, path, context.context.repository.id);
        const language = contentLanguagePolicy(hasOption(args, "content-language") ? value(args, "content-language") : undefined, undefined);
        return module.candidateSubmissionTemplate(runID, context.context.dev_run.development ? captureCommittedDevelopment(path, context.context.dev_run.development, baseCommit, route ? "external-runtime" : true).artifact : captureCommittedCandidate(path, baseCommit).artifact, language?.language);
      };
      return route ? routes.capture(route.route_id, runID, cwd, capture) : worktrees.capture(runID, capture);
    }
    if (group === "verification" && action === "template") { const language = contentLanguagePolicy(hasOption(args, "content-language") ? value(args, "content-language") : undefined, undefined); return module.verificationReportTemplate(resourceID(args, "candidate", "candidate"), language?.language, verificationRole(args)); }
    if (group === "verification" && action === "context") {
      const candidateID = resourceID(args, "candidate", "candidate"), phase = value(args, "phase", "blind") as ReviewPhase, role = verificationRole(args) as ReviewRole;
      // When the caller names a review session, that session's run gates the phase and records the step.
      if (hasOption(args, "review-session")) {
        const sessionID = value(args, "review-session");
        const observer = new VerificationRunObserver(opened.store);
        if (phase === "reconcile") await observer.assertReconcileAllowed(candidateID, sessionID);
        const run = await observer.find(candidateID, sessionID);
        const startedAt = new Date().toISOString();
        const result = await module.verificationContext(candidateID, phase, role);
        const target = materialOutput(args, cwd, (sessions, id) => sessions.contextPath(candidateID, id, role, phase));
        const outputPath = target ? writeMaterial(target, result.context) : undefined;
        if (run) {
          const runs = new VerificationRuns(opened.store);
          // The reconcile phase's work is not CLI-observable, so the entry opens the reconcile stage and
          // the coordinator closes it after the same verifier finishes; the blind phase is unchanged.
          if (phase === "reconcile") await runs.ensureStage(run.id, "reconcile");
          await runs.command(run.id, phase === "blind" ? "prepare" : "reconcile", { entry: `verification context --phase ${phase} --role ${role}`, argv_digest: commandDigest(args.positionals), started_at: startedAt, ended_at: new Date().toISOString(), state: "succeeded" });
        }
        return outputPath ? { ...result, output_path: outputPath } : result;
      }
      const result = await module.verificationContext(candidateID, phase, role);
      const target = materialOutput(args, cwd, (sessions, id) => sessions.contextPath(candidateID, id, role, phase));
      return target ? { ...result, output_path: writeMaterial(target, result.context) } : result;
    }
    if (group === "verification" && action === "submit") {
      const candidateID = resourceID(args, "candidate", "candidate"); const op = operationID(args, io);
      const mode = (hasOption(args, "mode") ? value(args, "mode") : "normal") as VerificationMode;
      if (!VERIFICATION_MODES.includes(mode)) throw validation("mode", `must be one of ${VERIFICATION_MODES.join(", ")}`);
      if (mode === "ultra") {
        // Ultra needs both signed parts; a plain --file has no verifier signature to bind a second role to.
        if (!hasOption(args, "handoff") || !hasOption(args, "quality-handoff")) throw validation("mode", "ultra requires both --handoff (contract part) and --quality-handoff (quality part)");
        if (hasOption(args, "file")) throw validation("file", "is not supported with --mode ultra");
      } else if (hasOption(args, "quality-handoff")) throw validation("quality-handoff", "requires --mode ultra; refusing to drop the quality part and record a normal Verification");
      if (hasOption(args, "file") === hasOption(args, "handoff")) throw validation("file", "use exactly one of --file or --handoff");
      if (hasOption(args, "handoff") && (hasOption(args, "agent-id") || hasOption(args, "agent-name"))) throw validation("attribution", "--agent-id/--agent-name are embedded in --handoff and must not be supplied again");
      const prepared = hasOption(args, "handoff") ? decodeVerificationHandoffFile(required(args, "handoff")) : { report: decodeVerificationReportFile(required(args, "file")), attribution: actor() };
      if (prepared.report.candidate_id !== candidateID) throw validation("candidate_id", "must match the VerificationReport candidate_id");
      const quality = mode === "ultra" ? decodeQualityHandoffFile(required(args, "quality-handoff")) : undefined;
      if (quality && quality.report.candidate_id !== candidateID) throw validation("candidate_id", "must match the quality review report candidate_id");
      const policy = contentLanguagePolicy(hasOption(args, "content-language") ? value(args, "content-language") : undefined, hasOption(args, "language-override-reason") ? value(args, "language-override-reason") : undefined);
      const languageWarnings = checkContentLanguage([...verificationProse(prepared.report), ...(quality ? qualityProse(quality.report) : [])], policy);
      const submitted = await module.submitVerification({ operation_id: op, report: prepared.report, attribution: prepared.attribution, ...(quality ? { quality: { report: quality.report, attribution: quality.attribution } } : {}) });
      // A run bound to the same Candidate, report role and blind digest records this submit automatically;
      // an ambiguous or absent binding leaves the legacy path untouched.
      const observer = new VerificationRunObserver(opened.store);
      const run = await observer.findByReport(candidateID, prepared.report.blind_context_digest, reportRole(prepared.report.format));
      if (run) {
        const startedAt = new Date().toISOString();
        const runs = new VerificationRuns(opened.store);
        // The public submit already succeeded, so its stage closes succeeded; the record never re-runs it.
        await runs.span(run.id, "submit", async () => { await runs.recordSubmit(run.id, "confirmed", op, submitted.verification_id); });
        await runs.command(run.id, "submit", { entry: "verification submit", argv_digest: commandDigest(args.positionals), started_at: startedAt, ended_at: new Date().toISOString(), state: "succeeded" });
      }
      return { ...submitted, warnings: languageWarnings };
    }
    if (group === "verification" && action === "show") return module.showVerification(resourceID(args, "verification", "verification"));
    if (group === "verification" && action === "list") {
      if (hasOption(args, "verdict") && bool(args, "paged")) throw validation("verdict", "is not supported with --paged");
      if (bool(args, "paged") && hasOption(args, "limit")) throw validation("limit", "is not supported with --paged (Candidate pages are fixed at 256 entries)");
      return bool(args, "paged") ? module.verificationPage(required(args, "candidate"), value(args, "cursor")) : module.listVerifications(value(args, "candidate"), { ...(hasOption(args, "verdict") ? { verdict: value(args, "verdict") } : {}) }, pageRequest(args));
    }
    if (group === "ledger" && action === "list") return module.listLedger(value(args, "after"), value(args, "repository"), value(args, "subject-type"), value(args, "subject-id"), integerValue(args, "limit", 0, "0"));
    if (group === "ledger" && action === "show") {
      const eventID = resourceID(args, "event", "event");
      // A ledger event ID is an opaque UUIDv7 that must be discovered from
      // `ledger list` (or the operation_id printed by a write command).  Keep
      // the guidance next to the failure instead of forcing a source read.
      try {
        return await module.showLedger(eventID);
      } catch (error) {
        if (error instanceof DomainError && error.code === "VALIDATION_ERROR" && error.details.field === "event_id") {
          throw validation("event", `is not a ledger event ID; use \`ledger list\` to find one, or \`ledger show --event <event-id>\``);
        }
        throw error;
      }
    }
    throw validation("command", `unknown command: ${group} ${action}`);
    })();
  } finally {
    try { await opened.store.close(); }
    catch (error) { preparedMarkdown?.dispose(); throw error; }
  }
};

const human = (valueToPrint: unknown, markdown = false): string => {
  if (typeof valueToPrint === "string") return valueToPrint;
  if (valueToPrint && typeof valueToPrint === "object" && (valueToPrint as { result_type?: unknown }).result_type === "patchledger.result.review-trace/v3") return markdown ? renderReviewMarkdown(valueToPrint as ReviewTraceResult) : renderReviewTrace(valueToPrint as ReviewTraceResult);
  if (valueToPrint && typeof valueToPrint === "object" && (valueToPrint as { result_type?: string }).result_type === "patchledger.result.review-summary/v1") return renderReviewSummary(valueToPrint as ReviewSummaryResult);
  return JSON.stringify(valueToPrint, null, 2);
};
/** Offline contract or quality report, told apart by its format string, with what handoff and digest commands need from either. */
const offlineReportSubject = (file: string) => {
  if ((safeYAMLToJS<{ format?: unknown }>(decodeFile(file)) ?? {}).format === QUALITY_REPORT_FORMAT) {
    const report = decodeQualityReviewReportFile(file);
    return { report, independentDigest: independentDigestOfQuality(report), prose: qualityProse(report), handoffResultType: "patchledger.result.quality-handoff/v1", sign: (verifier: Attribution) => createQualityHandoff(report, verifier) };
  }
  const report = decodeVerificationReportFile(file);
  return { report, independentDigest: independentDigestOfContract(report), prose: verificationProse(report), handoffResultType: "patchledger.result.verification-handoff/v1", sign: (verifier: Attribution) => createVerificationHandoff(report, verifier) };
};

const verificationRole = (args: ParsedArgs): "contract" | "quality" => {
  return parseVerificationRole(hasOption(args, "role") ? value(args, "role") : "contract");
};

export const exitCode = (error: DomainError): number => ({ VALIDATION_ERROR: 2, NOT_FOUND: 3, VERIFICATION_SET_CHANGED: 4, LIST_CHANGED: 4, STATE_CONFLICT: 4, AUTH_FAILED: 4, VERSION_CONFLICT: 4, PREDECESSOR_CONFLICT: 4, IDEMPOTENCY_CONFLICT: 4, SCHEMA_INCOMPATIBLE: 5, MIGRATION_DIRTY: 5, BRAND_MIGRATION_REQUIRED: 5, DATABASE_ID_MISMATCH: 5, REPOSITORY_NOT_RESOLVED: 6, REPOSITORY_AMBIGUOUS: 6, BASELINE_UNAVAILABLE: 6, REPOSITORY_ISSUE_LIMIT: 6, WORKTREE_MISMATCH: 6, ARTIFACT_TOO_LARGE: 6, ARTIFACT_INTEGRITY_ERROR: 6, STORAGE_TRANSIENT: 7, INTERNAL: 1 } as Record<string, number>)[error.code] ?? 1;

const writeCommands = new Set([
  "code-workspace:end", "code-workspace:cleanup", "code-workspace:service-cleanup", "code-workspace:service-volume-retire", "code-workspace:service-volume-delete", "code-workspace:service-volume-restoration-cleanup", "code-workspace:service-volume-export", "code-workspace:service-volume-restore", "code-workspace:service-volume-restoration-stop",
  "code-workspace:execution-start",
  "code-workspace:route-prepare",
  "code-workspace:route-bind",
  "code-workspace:recipe-save", "code-workspace:recipe-prepare", "code-workspace:recipe-preparation-cancel", "code-workspace:recipe-preparation-cleanup",
  "code-workspace:build-material-capture", "code-workspace:image-prepare", "code-workspace:image-cancel", "code-workspace:image-cleanup",
  "code-workspace:environment-check", "code-workspace:environment-set-default",
  "code-workspace:environment-save",
  "code-workspace:config-save",
  "code-workspace:create",
  "code-workspace:restore",
  "repository:archive-bind",
  "integration:observe", "integration:authorize", "integration:consume", "integration:landing",
  "delivery-link:withdraw",
  "delivery-link:record",
  "completion:record",
  "completion:reopen",
  "selection:set",
  "selection:clear",
  "repository:register",
  "repository:move",
  "repository:alias-add",
  "repository:alias-retire",
  "devrun:start",
  "devrun:prepare", "devrun:admit",
  "preflight:observe", "preflight:assess",
  "devrun:continue",
  "devrun:sync", "devrun:sync-complete", "devrun:sync-abandon",
  "devrun:abandon",
  "devrun:cleanup",
  "candidate:submit",
  "candidate:archive",
  "verification:submit",
]);

const observationView = (record: RuntimeRecord): Record<string, unknown> => {
  const data = observationData(record);
  return { observation_id: record.id, phase: data.phase, observed_at: data.observed_at, target: data.target, tracking_ref: data.tracking_ref, observation: data.observation, ...(data.definition_reference ? { definition_reference: data.definition_reference } : {}), binds: data.binds };
};
/** The Workspace's own canonical remote, read without registering the Repository. */
const readWorkspaceRemote = (path: string): string | undefined => {
  try { return (JSON.parse(readFileSync(join(path, ".workspace.json"), "utf8")) as { repository_remote?: unknown }).repository_remote as string | undefined; }
  catch { return undefined; }
};
const assessmentView = (record: RuntimeRecord): Record<string, unknown> => {
  const data = assessmentData(record);
  return { assessment_id: record.id, observation_id: data.observation_id, assessment: data.assessment, author: data.author, rationale: data.rationale, affected: data.affected, assessed_at: data.assessed_at, binds: data.binds, ...(data.target_commit ? { target_commit: data.target_commit } : {}) };
};

export const commandNeedsOperationID = (args: ParsedArgs): boolean =>
  !(args.positionals[0] === "candidate" && args.positionals[1] === "archive" && bool(args, "dry-run")) && (args.positionals[0] === "selection" && args.positionals[1] === "materialize" && bool(args, "allow-unverified")) || evalNeedsOperation(args) || qaDraftNeedsOperation(args) || writeCommands.has(`${args.positionals[0] ?? "help"}:${args.positionals[1] ?? ""}`);

export const runCLI = async (argv: string[], io: CLIIO = {}): Promise<number> => {
  const args = parseArgs(argv);
  const jsonMode = jsonOutputRequested(args);
  const supplied = value(args, "operation-id");
  const needsOperationID = !bool(args, "help") && commandNeedsOperationID(args);
  const operationOptionPresent = hasOption(args, "operation-id");
  // Do not put an invalid caller-supplied ID in the error envelope.  The
  // command handler still performs the canonical validation, but the outer
  // envelope must itself remain schema-valid when that validation fails.
  const suppliedIsValid = !operationOptionPresent || (Boolean(supplied) && isUUIDv7(supplied));
  const op = needsOperationID ? (operationOptionPresent ? (suppliedIsValid ? supplied : "") : newUUIDv7()) : "";
  if (needsOperationID && !operationOptionPresent) stderr(io, `operation_id: ${op}`);
  const effectiveArgv = needsOperationID && !operationOptionPresent ? [...argv, "--operation-id", op] : argv;
  try {
    // Validate a caller-supplied operation ID before any command preparation
    // (config/database access, YAML decoding, or Git capture).  Besides
    // avoiding unnecessary side effects, this keeps the failure envelope
    // deterministic and guarantees that an invalid ID can never be echoed
    // back as an operation_id value.
    if (needsOperationID && operationOptionPresent && !suppliedIsValid) {
      throw validation("operation_id", "must be a lowercase UUIDv7");
    }
    const data = await execute(effectiveArgv, io);
    if (data instanceof PreparedReviewMarkdown) { await data.print(async line => { if (io.stdout) io.stdout(line); else if (!process.stdout.write(line + "\n")) await new Promise<void>(resolve => process.stdout.once("drain", resolve)); }); return 0; }
    const warnings = data && typeof data === "object" && "warnings" in data && Array.isArray((data as { warnings?: unknown }).warnings) ? (data as { warnings: Warning[] }).warnings : [];
    const cleanData = data && typeof data === "object" && !Array.isArray(data) && "warnings" in data
      ? Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([key]) => key !== "warnings"))
      : data;
    const envelope: SuccessEnvelope = {
      format: "patchledger.cli/v1",
      ok: true,
      ...(op ? { operation_id: op } : {}),
      data: cleanData,
      warnings,
    };
    if (jsonMode) stdout(io, JSON.stringify(envelope));
    else {
      if (op) stdout(io, `operation_id: ${op}`);
      stdout(io, human(cleanData, bool(args, "markdown")));
    }
    return codeExecutionExitCode(cleanData);
  } catch (error) {
    const domain = asDomainError(error);
    const envelope = { format: "patchledger.cli/v1", ok: false, ...(op ? { operation_id: op } : {}), error: domain.toJSON() };
    if (jsonMode) stdout(io, JSON.stringify(envelope));
    else {
      if (op) stderr(io, `operation_id: ${op}`);
      stderr(io, `${domain.code}: ${domain.message}`);
    }
    return exitCode(domain);
  }
};
