import { readFileSync, lstatSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { sha256Bytes, sha256 } from "./canonical-json.js";
import { DomainError, validation, worktreeMismatch, stateConflict, baselineUnavailable } from "./errors.js";
import { readReviewWorktreeMarker, assertReviewWorktreeCandidateArtifact } from "./git.js";
import type { Module } from "./module.js";
import { indexCandidateChanges, matchChangeLine } from "./change-index.js";
import { assertHistoryRepository, historyGit, withHistoryRead, assertNoHistoryFilters, deliveryProof, historyBlob, lineAtCommit, lineOrigin, uniqueLineMap, sourceLines, assertHistoryBudget } from "./git-history.js";

export interface TraceInput { snippet_file?: string; path?: string; start_line?: number; end_line?: number; candidate_limit?: number }
export interface SourceLocation { path: string; start_line: number; end_line: number }
export interface TraceSegment {
  candidate_id: string; origin: "recorded_delivery" | "review_snapshot" | "unrecorded";
  content: string; connection: string; source: SourceLocation; historical: SourceLocation;
  issue_id: string; issue_version: number; requirement_id: string; requirement_version: number;
  review_argv: string[];
  evidence: { patch_digest: string; change_unit_ids: string[]; commit_oid?: string; parent_oid?: string; delivery_link?: { id: string; version: number; state: string } };
}

export async function traceSource(cwd: string, repositoryID: string, input: TraceInput, module: Module, databaseId: string) {
  return withHistoryRead(async () => {
  const candidateLimit = input.candidate_limit ?? 200;
  if (!Number.isInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 200) throw validation("limit", "must be between 1 and 200");
  assertHistoryRepository(cwd);
  const git = (...args: string[]) => historyGit(cwd, args);
  const commit = git("rev-parse", "HEAD").trim();
  const marker = readReviewWorktreeMarker(cwd);
  if (marker) {
    assertNoHistoryFilters(cwd);
    if (marker.database_id !== databaseId) throw new DomainError("DATABASE_ID_MISMATCH", "Review snapshot belongs to another database");
    const { record, issue, repository_id } = await module.historyCandidate(marker.candidate_id);
    if (repository_id !== repositoryID || marker.repository_id !== repositoryID || marker.baseline_oid !== (record.candidate.base_commit ?? issue.baseline.git_oid) || marker.patch_digest !== record.candidate.patch_digest || marker.result_tree_oid !== record.candidate.result_tree_oid) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Review marker does not match Candidate");
    assertReviewWorktreeCandidateArtifact(cwd, marker);
  }
  if (Boolean(input.snippet_file) === Boolean(input.path)) throw validation("source", "choose a snippet file or a path and range");
  const readText = (path: string, limit: number): { bytes: Buffer; text: string } => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > limit) throw validation("source", "requires a regular UTF-8 text file within the size budget");
    const bytes = readFileSync(path);
    try {
      if (bytes.includes(0)) throw new Error("binary");
      return { bytes, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
    } catch { throw validation("source", "requires UTF-8 text without NUL bytes"); }
  };
  const sourceStat = (path: string) => {
    if (isAbsolute(path) || path.split("/").some(p => p === ".." || p === ".git" || !p) || path.includes("\0")) throw validation("path", "requires a repository-relative source path");
    let component = cwd;
    const parts = path.split("/");
    let stat;
    for (let i = 0; i < parts.length; i++) {
      component = join(component, parts[i]); stat = lstatSync(component);
      if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) throw validation("path", "source paths cannot traverse links or non-directories");
    }
    return stat!;
  };
  const readSourceText = (path: string) => {
    sourceStat(path);
    return readText(join(cwd, path), 2 * 1024 * 1024);
  };
  const snippet = input.snippet_file ? readText(input.snippet_file, 64 * 1024).text.replace(/\n$/, "") : "";
  if (input.snippet_file && !snippet.trim()) throw validation("snippet-file", "must contain code");
  const matches: SourceLocation[] = [];
  const fileDigests = new Map<string, string>();
  const limitations: string[] = [];
  let scannedBytes = 0, scannedFiles = 0;
  let scanPaths: string[] | undefined;
  const absentPaths = new Set<string>();
  if (input.path) {
    const { bytes: explicitBytes, text: explicitText } = readSourceText(input.path);
    fileDigests.set(input.path, sha256Bytes(explicitBytes));
    const lines = sourceLines(explicitText);
    const start = input.start_line ?? 1; const end = input.end_line ?? start;
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start || end > lines.length || end - start >= 10000) throw validation("range", "invalid line range");
    matches.push({ path: input.path, start_line: start, end_line: end });
  } else {
  scanPaths = [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean))];
  scan: for (const path of scanPaths) {
    let stat;
    try { stat = sourceStat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { absentPaths.add(path); continue; }
      if (error instanceof DomainError && error.code === "VALIDATION_ERROR") { limitations.push("unsupported_file"); continue; }
      throw error;
    }
    if (!stat.isFile()) { limitations.push("unsupported_file"); continue; }
    if (stat.size > 2 * 1024 * 1024) { limitations.push("file_size_budget"); continue; }
    if (++scannedFiles > 20_000 || (scannedBytes += stat.size) > 64 * 1024 * 1024) { limitations.push("scan_budget"); break; }
    let source: string;
    try {
      const decoded = readSourceText(path);
      source = decoded.text; fileDigests.set(path, sha256Bytes(decoded.bytes));
    } catch (error) {
      if (error instanceof DomainError && error.code === "VALIDATION_ERROR") { limitations.push("unsupported_encoding"); continue; }
      throw error;
    }
    const normalize = (lines: string[]) => {
      const nonempty = lines.filter(line => line.trim());
      const indent = nonempty.length ? Math.min(...nonempty.map(line => /^[ \t]*/.exec(line)![0].length)) : 0;
      return lines.map(line => line.trim() ? line.slice(indent) : "").join("\n");
    };
    const needleLines = snippet.split("\n"), sourceLines = source.replace(/\n$/, "").split("\n");
    const needle = normalize(needleLines);
    for (let i = 0; i + needleLines.length <= sourceLines.length; i++) {
      assertHistoryBudget();
      const block = sourceLines.slice(i, i + needleLines.length);
      if (block.join("\n").includes(snippet) || normalize(block) === needle) {
        if (matches.length === 512) { limitations.push("location_budget"); break scan; }
        matches.push({ path, start_line: i + 1, end_line: i + needleLines.length });
      }
    }
  }
  }
  const localOnly: SourceLocation[] = [];
  const locationIncomplete = limitations.length > 0;
  const selectedPaths = [...new Set(matches.map(m => m.path))];
  const readIndex = () => {
    if (!selectedPaths.length) return { entries: "", staged_paths: [] as string[], unmerged_paths: [] as string[] };
    const entries = git("--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...selectedPaths);
    const unmerged_paths = [...new Set(entries.split("\0").flatMap(entry => {
      const match = /^[0-7]{6} [0-9a-f]+ [123]\t([\s\S]*)$/.exec(entry);
      return match ? [match[1]] : [];
    }))];
    const staged_paths = git("--literal-pathspecs", "diff", "--cached", "--name-only", "--no-renames", "-z", commit, "--", ...selectedPaths).split("\0").filter(Boolean);
    return { entries, staged_paths, unmerged_paths };
  };
  const index = readIndex();
  if (index.unmerged_paths.length) limitations.push("unresolved_index_conflict");
  let workingMap: Array<number | null | undefined> = [];
  if (matches.length === 1 && !limitations.length && !marker) {
    const loc = matches[0];
    const current = readSourceText(loc.path).text;
    const old = historyBlob(cwd, commit, loc.path);
    workingMap = uniqueLineMap(old, current);
    for (let line = loc.start_line; line <= loc.end_line; line++) {
      if (workingMap[line - 1] === undefined) limitations.push("working_copy_mapping_unresolved");
      if (workingMap[line - 1] === null) {
        const last = localOnly.at(-1);
        if (last && last.end_line === line - 1) last.end_line = line;
        else localOnly.push({ path: loc.path, start_line: line, end_line: line });
      }
    }
  }
  const segments: TraceSegment[] = [];
  let segmentBytes = 0;
  const appendSegment = (segment: TraceSegment): void => {
    assertHistoryBudget();
    const bytes = Buffer.byteLength(JSON.stringify(segment));
    if (segments.length < 2000 && segmentBytes + bytes <= 512 * 1024) { segments.push(segment); segmentBytes += bytes; }
    else if (!limitations.includes("output_budget")) limitations.push("output_budget");
  };
  if (matches.length === 1 && !limitations.length && marker) {
    const loc = matches[0];
    const { record, issue, requirement_version } = await module.historyCandidate(marker.candidate_id);
    const units = indexCandidateChanges(record.artifact).change_units.filter(u => u.display_path === loc.path);
    for (let line = loc.start_line; line <= loc.end_line; line++) if (matchChangeLine(record.artifact, units, line, "new").status === "added") {
      appendSegment({ candidate_id: marker.candidate_id, origin: "review_snapshot", content: "exact_artifact", connection: "snapshot_exact", source: { path: loc.path, start_line: line, end_line: line }, historical: { path: loc.path, start_line: line, end_line: line }, issue_id: issue.issue_id, issue_version: issue.revision_number, requirement_id: issue.requirement_id, requirement_version, evidence: { patch_digest: record.candidate.patch_digest, change_unit_ids: matchChangeLine(record.artifact, units, line, "new").change_units.map(u => u.change_unit_id) }, review_argv: ["review", "--summary", marker.candidate_id, "--at", `${loc.path}:${line}`] });
    }
  }
  if (matches.length === 1 && !limitations.length && !marker) {
    const loc = matches[0];
    const snapshot = await module.historySnapshot(repositoryID, loc.path);
    const selectedIds = new Set([...new Set([...snapshot.links.filter(l => l.state === "recorded" && l.units.some(u => u.path === loc.path)).map(l => l.candidate_id), ...snapshot.candidate_ids])].slice(0, candidateLimit));
    if (snapshot.candidate_ids.length > candidateLimit || snapshot.links.length > 1000) limitations.push("candidate_budget");
    for (const link of snapshot.links.slice(0, 1000)) {
      if (!selectedIds.has(link.candidate_id)) continue;
      if (link.state !== "recorded") continue;
      const verified = await deliveryProof(module, cwd, repositoryID, link.candidate_id, link.commit_oid);
      if (verified.parent_oid !== link.parent_oid || verified.patch_digest !== link.patch_digest || verified.content !== link.content || sha256(verified.units) !== sha256(link.units)) throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Delivery evidence does not match raw Git history", false, { resource_id: link.id });
      const { record, issue, requirement_version } = await module.historyCandidate(link.candidate_id);
      const units = indexCandidateChanges(record.artifact).change_units.filter(u => u.display_path === loc.path);
      for (let line = loc.start_line; line <= loc.end_line; line++) {
        const headLine = workingMap[line - 1];
        if (headLine == null) continue;
        const historicalLine = lineAtCommit(cwd, commit, link.commit_oid, loc.path, headLine);
        if (historicalLine === undefined) continue;
        const mapping = link.units.find(u => u.path === loc.path && historicalLine >= u.commit_start && historicalLine < u.commit_start + u.lines);
        if (!mapping) continue;
        const candidateLine = mapping.candidate_start + historicalLine - mapping.commit_start;
        if (matchChangeLine(record.artifact, units, candidateLine, "new").status !== "added") continue;
        appendSegment({ candidate_id: link.candidate_id, origin: "recorded_delivery", content: link.content, connection: "mapped", source: { path: loc.path, start_line: line, end_line: line }, historical: { path: loc.path, start_line: candidateLine, end_line: candidateLine }, issue_id: issue.issue_id, issue_version: issue.revision_number, requirement_id: issue.requirement_id, requirement_version, evidence: { patch_digest: link.patch_digest, change_unit_ids: [mapping.change_unit_id], commit_oid: link.commit_oid, parent_oid: link.parent_oid, delivery_link: { id: link.id, version: link.version, state: link.state } }, review_argv: ["review", "--summary", link.candidate_id, "--at", `${loc.path}:${candidateLine}`] });
      }
    }
    for (let line = loc.start_line; line <= loc.end_line; line++) {
      const headLine = workingMap[line - 1];
      if (headLine == null) continue;
      const origin = lineOrigin(cwd, commit, loc.path, headLine);
      if (!origin) { limitations.push("history_mapping_unresolved"); continue; }
      for (const id of snapshot.candidate_ids.filter(id => selectedIds.has(id))) {
        if (segments.some(s => s.candidate_id === id && s.source.start_line === line)) continue;
        let proof;
        try { proof = await deliveryProof(module, cwd, repositoryID, id, origin.commit); }
        catch (e) { if (e instanceof DomainError && e.code === "VALIDATION_ERROR") continue; throw e; }
        const { record, issue, requirement_version } = await module.historyCandidate(id);
        const units = indexCandidateChanges(record.artifact).change_units.filter(u => u.display_path === loc.path);
        const mapping = proof.units.find(u => u.path === loc.path && origin.line >= u.commit_start && origin.line < u.commit_start + u.lines);
        if (!mapping) continue;
        const candidateLine = mapping.candidate_start + origin.line - mapping.commit_start;
        if (matchChangeLine(record.artifact, units, candidateLine, "new").status !== "added") continue;
        const withdrawn = snapshot.links.find(l => l.candidate_id === id && l.commit_oid === origin.commit && l.state === "withdrawn");
        appendSegment({ candidate_id: id, origin: "unrecorded", content: proof.content, connection: "mapped", source: { path: loc.path, start_line: line, end_line: line }, historical: { path: loc.path, start_line: candidateLine, end_line: candidateLine }, issue_id: issue.issue_id, issue_version: issue.revision_number, requirement_id: issue.requirement_id, requirement_version, evidence: { patch_digest: proof.patch_digest, change_unit_ids: [mapping.change_unit_id], commit_oid: proof.commit_oid, parent_oid: proof.parent_oid, ...(withdrawn ? { delivery_link: { id: withdrawn.id, version: withdrawn.version, state: withdrawn.state } } : {}) }, review_argv: ["review", "--summary", id, "--at", `${loc.path}:${candidateLine}`] });
      }
    }
    if (sha256(await module.historySnapshot(repositoryID, loc.path)) !== sha256(snapshot)) throw stateConflict("repository", repositoryID, "Candidate or delivery association set changed; retry the trace");
  }
  const unexplained: SourceLocation[] = [];
  if (matches.length === 1) {
    const loc = matches[0];
    for (let line = loc.start_line; line <= loc.end_line; line++) {
      if (segments.some(s => s.source.start_line === line) || localOnly.some(s => s.start_line <= line && s.end_line >= line)) continue;
      const previous = unexplained.at(-1);
      if (previous && previous.end_line === line - 1) previous.end_line = line;
      else unexplained.push({ path: loc.path, start_line: line, end_line: line });
    }
  }
  for (const path of absentPaths) {
    try { sourceStat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    throw worktreeMismatch("", "Previously absent source appeared during the query");
  }
  const files = [...new Set(matches.map(m => m.path))].map(path => ({ path, content_digest: fileDigests.get(path)! }));
  for (const [path, digest] of fileDigests) if (sha256Bytes(readSourceText(path).bytes) !== digest) throw worktreeMismatch("", "Trace source changed during the query");
  if (scanPaths && sha256(scanPaths) !== sha256([...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean))])) throw worktreeMismatch("", "Trace source inventory changed during the query");
  if (sha256(index) !== sha256(readIndex())) throw worktreeMismatch("", "Trace index state changed during the query");
  const result = {
    result_type: "patchledger.result.code-history-trace/v1", command: "trace",
    source: { index: { staged_paths: index.staged_paths, unmerged_paths: index.unmerged_paths }, database_id: databaseId, repository_id: repositoryID, commit_oid: commit, input_digest: input.snippet_file ? sha256Bytes(Buffer.from(snippet)) : sha256({ locations: matches, files }), files, scan_digest: sha256([...fileDigests]) },
    locations: { resolution: input.path ? "explicit" : locationIncomplete ? "incomplete" : matches.length === 1 ? "unique_in_scan" : matches.length ? "ambiguous" : "not_found", matches },
    segments, coverage: { candidate_search_complete: matches.length === 1 && !limitations.length, local_only: localOnly, unexplained }, limitations: [...new Set(limitations)],
    next_action: limitations.length ? "narrow_query" : matches.length === 1 ? "complete" : "choose_location",
  };
  assertHistoryBudget();
  if (localOnly.length > 2000 || unexplained.length > 2000 || Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024 - 1024) throw baselineUnavailable("output_byte_budget exhausted; narrow the source range");
  return result;
  });
}
