import { createHash } from "node:crypto";
import { sha256, sha256Bytes } from "./canonical-json.js";
import type { CandidateArtifact, CandidateFile, CandidateSubmissionInput, IssueRevision } from "./domain.js";
import { DomainError } from "./errors.js";

export const CHANGE_INDEX_FORMAT = "patchledger.change-index/v1" as const;

export interface ChangeRange {
  start: number;
  lines: number;
}

export interface ChangeUnit {
  change_unit_id: string;
  kind: "hunk" | "file";
  path_bytes: string;
  display_path: string;
  change: string;
  old_path_bytes?: string;
  old_range?: ChangeRange;
  new_range?: ChangeRange;
  content_digest: string;
}

export interface ChangeIndex {
  format: typeof CHANGE_INDEX_FORMAT;
  patch_digest: string;
  units_digest: string;
  change_units: ChangeUnit[];
}

export type ChangeLineStatus = "added" | "deleted" | "context" | "outside_hunks" | "unavailable";

export interface ChangeLineMatch {
  status: ChangeLineStatus;
  change_units: ChangeUnit[];
}

export interface ChangeRationaleBindingInspection {
  change_index: ChangeIndex;
  problems: string[];
  explained_change_unit_ids: string[];
  unexplained_change_unit_ids: string[];
}

interface ByteLine {
  start: number;
  end: number;
  textEnd: number;
}

interface IndexedChangeUnit {
  unit: ChangeUnit;
  bytes: Buffer;
}

const linesWithin = (buffer: Buffer, start: number, end: number): ByteLine[] => {
  const lines: ByteLine[] = [];
  let offset = start;
  while (offset < end) {
    const newline = buffer.indexOf(0x0a, offset);
    const lineEnd = newline < 0 || newline >= end ? end : newline + 1;
    const textEnd = lineEnd > offset && buffer[lineEnd - 1] === 0x0a
      ? (lineEnd - 1 > offset && buffer[lineEnd - 2] === 0x0d ? lineEnd - 2 : lineEnd - 1)
      : lineEnd;
    lines.push({ start: offset, end: lineEnd, textEnd });
    offset = lineEnd;
  }
  return lines;
};

const sectionStarts = (patch: Buffer): number[] => {
  const marker = Buffer.from("diff --git ", "ascii");
  const starts: number[] = [];
  let offset = 0;
  while (offset < patch.length) {
    const found = patch.indexOf(marker, offset);
    if (found < 0) break;
    if (found === 0 || patch[found - 1] === 0x0a) starts.push(found);
    offset = found + marker.length;
  }
  return starts;
};

const hunkRange = (header: string): { old_range: ChangeRange; new_range: ChangeRange } | undefined => {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(header);
  if (!match) return undefined;
  const range = (start: string, lines: string | undefined): ChangeRange => ({ start: Number(start), lines: lines === undefined ? 1 : Number(lines) });
  return { old_range: range(match[1], match[2]), new_range: range(match[3], match[4]) };
};

const gitQuotedPath = (path: Buffer): Buffer => {
  let value = '"';
  const named = new Map<number, string>([[0x07, "a"], [0x08, "b"], [0x09, "t"], [0x0a, "n"], [0x0b, "v"], [0x0c, "f"], [0x0d, "r"]]);
  for (const byte of path) {
    const escape = named.get(byte);
    if (escape) value += `\\${escape}`;
    else if (byte === 0x22 || byte === 0x5c) value += `\\${String.fromCharCode(byte)}`;
    else if (byte < 0x20 || byte >= 0x7f) value += `\\${byte.toString(8).padStart(3, "0")}`;
    else value += String.fromCharCode(byte);
  }
  return Buffer.from(`${value}"`, "ascii");
};

const expectedSectionHeaders = (file: CandidateFile): Buffer[] => {
  const current = Buffer.from(file.path_bytes, "base64");
  const old = file.old_path_bytes === undefined ? current : Buffer.from(file.old_path_bytes, "base64");
  const left = Buffer.concat([Buffer.from("a/", "ascii"), old]);
  const right = Buffer.concat([Buffer.from("b/", "ascii"), current]);
  return [
    Buffer.concat([Buffer.from("diff --git ", "ascii"), left, Buffer.from(" ", "ascii"), right]),
    Buffer.concat([Buffer.from("diff --git ", "ascii"), gitQuotedPath(left), Buffer.from(" ", "ascii"), gitQuotedPath(right)]),
  ];
};

const integrity = (reason: string): never => {
  throw new DomainError("ARTIFACT_INTEGRITY_ERROR", "Candidate patch cannot be indexed", false, { reason });
};

const typeChangeModes = (file: CandidateFile): boolean => {
  const modes = new Set(["100644", "100755", "120000", "160000"]);
  return file.change === "type_changed" && file.old_path_bytes === undefined
    && modes.has(file.old_mode ?? "") && modes.has(file.new_mode ?? "")
    && file.old_mode!.slice(0, 3) !== file.new_mode!.slice(0, 3);
};

/** Git represents a type change as an adjacent deletion/addition pair. Check
 * both halves against the one manifest entry before combining their bytes. */
const checkTypeChangeSection = (patch: Buffer, lines: ByteLine[], file: CandidateFile, deletion: boolean): void => {
  const text = (index: number): string => index < lines.length ? patch.subarray(lines[index].start, lines[index].textEnd).toString("ascii") : "";
  const mode = deletion ? file.old_mode : file.new_mode;
  if (text(1) !== `${deletion ? "deleted" : "new"} file mode ${mode}`) integrity(`type change ${file.display_path} has an invalid ${deletion ? "deletion" : "addition"} mode`);
  const index = /^index ([0-9a-f]{40}|[0-9a-f]{64})\.\.([0-9a-f]{40}|[0-9a-f]{64})$/.exec(text(2));
  if (!index || index[1].length !== index[2].length
    || (deletion ? !/^0+$/.test(index[2]) || /^0+$/.test(index[1]) : !/^0+$/.test(index[1]) || /^0+$/.test(index[2]))) integrity(`type change ${file.display_path} has an invalid full-index ${deletion ? "deletion" : "addition"}`);
  if (lines.length === 3) {
    const emptyOID = createHash(index![1].length === 40 ? "sha1" : "sha256").update("blob 0\0").digest("hex");
    if ((deletion ? index![1] : index![2]) !== emptyOID) integrity(`type change ${file.display_path} has a missing nonempty body`);
    return;
  }
  if (text(3) === "GIT binary patch") {
    // Binary body integrity is also verified when Git applies the full patch.
    let offset = 4;
    for (let block = 0; block < 2; block += 1) {
      const literal = /^literal (\d+)$/.exec(text(offset++));
      if (!literal || (deletion === (block === 0) ? literal[1] !== "0" : Number(literal[1]) < 1)) integrity(`type change ${file.display_path} has an invalid binary literal`);
      let encodedLines = 0;
      while (offset < lines.length && text(offset) !== "") {
        const encoded = text(offset++);
        const lead = encoded.charCodeAt(0);
        const bytes = lead >= 65 && lead <= 90 ? lead - 64 : lead >= 97 && lead <= 122 ? lead - 70 : 0;
        if (!bytes || encoded.length !== 1 + Math.ceil(bytes / 4) * 5 || !/^[A-Za-z][0-9A-Za-z!#$%&()*+\-;<=>?@^_`{|}~]+$/.test(encoded)) integrity(`type change ${file.display_path} has an invalid binary encoding`);
        encodedLines += 1;
      }
      if (!encodedLines || offset >= lines.length || text(offset++) !== "") integrity(`type change ${file.display_path} has an incomplete binary literal`);
    }
    if (offset !== lines.length) integrity(`type change ${file.display_path} has extra binary body data`);
    return;
  }
  const path = Buffer.concat([Buffer.from(deletion ? "a/" : "b/", "ascii"), Buffer.from(file.path_bytes, "base64")]);
  const prefix = Buffer.from(deletion ? "--- " : "+++ ", "ascii");
  const markers = [Buffer.concat([prefix, path]), Buffer.concat([prefix, gitQuotedPath(path)])];
  if (path.includes(0x20)) {
    markers.push(Buffer.concat([prefix, path, Buffer.from("\t", "ascii")]));
    markers.push(Buffer.concat([prefix, gitQuotedPath(path), Buffer.from("\t", "ascii")]));
  }
  const actualPath = patch.subarray(lines[deletion ? 3 : 4]?.start ?? 0, lines[deletion ? 3 : 4]?.textEnd ?? 0);
  if (!markers.some((marker) => marker.equals(actualPath)) || text(deletion ? 4 : 3) !== `${deletion ? "+++" : "---"} /dev/null`) integrity(`type change ${file.display_path} has an invalid ${deletion ? "deletion" : "addition"} path`);
  const ranges = hunkRange(text(5));
  if (!ranges || (deletion
    ? ranges.new_range.start !== 0 || ranges.new_range.lines !== 0 || ranges.old_range.start !== 1 || ranges.old_range.lines < 1
    : ranges.old_range.start !== 0 || ranges.old_range.lines !== 0 || ranges.new_range.start !== 1 || ranges.new_range.lines < 1)) integrity(`type change ${file.display_path} has an invalid whole-file hunk`);
  let count = 0;
  let noNewline = false;
  for (let lineIndex = 6; lineIndex < lines.length; lineIndex += 1) {
    if (text(lineIndex) === "\\ No newline at end of file" && count > 0 && !noNewline && lineIndex === lines.length - 1) noNewline = true;
    else if (patch[lines[lineIndex].start] === (deletion ? 0x2d : 0x2b) && !noNewline) count += 1;
    else integrity(`type change ${file.display_path} has an invalid whole-file body`);
  }
  if (count !== (deletion ? ranges!.old_range.lines : ranges!.new_range.lines)) integrity(`type change ${file.display_path} whole-file body does not match its hunk`);
};

const changeUnit = (
  artifact: CandidateArtifact,
  file: CandidateFile,
  kind: ChangeUnit["kind"],
  bytes: Buffer,
  ranges?: { old_range: ChangeRange; new_range: ChangeRange },
): ChangeUnit => {
  const contentDigest = sha256Bytes(bytes);
  const identity = {
    format: CHANGE_INDEX_FORMAT,
    patch_digest: artifact.patch_digest,
    path_bytes: file.path_bytes,
    ...(file.old_path_bytes === undefined ? {} : { old_path_bytes: file.old_path_bytes }),
    kind,
    ...(ranges ?? {}),
    content_digest: contentDigest,
  };
  return {
    change_unit_id: sha256(identity),
    kind,
    path_bytes: file.path_bytes,
    display_path: file.display_path,
    change: file.change,
    ...(file.old_path_bytes === undefined ? {} : { old_path_bytes: file.old_path_bytes }),
    ...(ranges ?? {}),
    content_digest: contentDigest,
  };
};

/**
 * Deterministically decompose the canonical full-index Git patch. Textual
 * changes become hunk-level units; binary, rename-only, mode-only, and other
 * sections without hunks become file-level units.
 */
const deriveChangeUnits = (artifact: CandidateArtifact): IndexedChangeUnit[] => {
  const starts = sectionStarts(artifact.patch);
  if (artifact.files.length === 0 && artifact.patch.length === 0) return [];
  if (starts[0] !== 0) integrity("patch does not begin with a diff --git file section");

  const indexed: IndexedChangeUnit[] = [];
  let sectionIndex = 0;
  for (const file of artifact.files) {
    const index = sectionIndex++;
    const start = starts[index];
    if (start === undefined) integrity(`patch is missing a file section for ${file.display_path}`);
    const end = starts[index + 1] ?? artifact.patch.length;
    const lines = linesWithin(artifact.patch, start, end);
    const header = artifact.patch.subarray(lines[0].start, lines[0].textEnd);
    if (!expectedSectionHeaders(file).some((expected) => expected.equals(header))) integrity(`patch file section ${index} does not match manifest path ${file.display_path}`);
    if (file.change === "type_changed") {
      if (!typeChangeModes(file)) integrity(`type change ${file.display_path} has invalid manifest modes or paths`);
      const additionStart = starts[sectionIndex];
      if (additionStart === undefined) integrity(`type change ${file.display_path} is missing its addition section`);
      const additionEnd = starts[sectionIndex + 1] ?? artifact.patch.length;
      const additionLines = linesWithin(artifact.patch, additionStart, additionEnd);
      const additionHeader = artifact.patch.subarray(additionLines[0].start, additionLines[0].textEnd);
      if (!expectedSectionHeaders(file).some((expected) => expected.equals(additionHeader))) integrity(`type change ${file.display_path} addition section does not match manifest path`);
      checkTypeChangeSection(artifact.patch, lines, file, true);
      checkTypeChangeSection(artifact.patch, additionLines, file, false);
      const bytes = artifact.patch.subarray(start, additionEnd);
      indexed.push({ unit: changeUnit(artifact, file, "file", bytes), bytes });
      sectionIndex += 1;
      continue;
    }
    const hunks: { offset: number; ranges: { old_range: ChangeRange; new_range: ChangeRange } }[] = [];
    for (const line of lines) {
      if (line.textEnd - line.start < 7 || artifact.patch[line.start] !== 0x40 || artifact.patch[line.start + 1] !== 0x40) continue;
      const header = artifact.patch.subarray(line.start, line.textEnd).toString("ascii");
      const ranges = hunkRange(header);
      if (ranges) hunks.push({ offset: line.start, ranges });
    }
    if (!hunks.length) {
      const bytes = artifact.patch.subarray(start, end);
      indexed.push({ unit: changeUnit(artifact, file, "file", bytes), bytes });
      continue;
    }
    for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex += 1) {
      const hunk = hunks[hunkIndex];
      const hunkEnd = hunks[hunkIndex + 1]?.offset ?? end;
      const bytes = artifact.patch.subarray(hunk.offset, hunkEnd);
      indexed.push({ unit: changeUnit(artifact, file, "hunk", bytes, hunk.ranges), bytes });
    }
  }
  if (sectionIndex !== starts.length) integrity(`patch contains ${starts.length} file sections but manifest accounts for ${sectionIndex}`);
  if (indexed.length > 100_000) throw new DomainError("ARTIFACT_TOO_LARGE", "Candidate patch contains too many Change Units", false, { reason: "Change Index must contain at most 100000 units" });
  return indexed;
};

export const indexCandidateChanges = (artifact: CandidateArtifact): ChangeIndex => {
  const units = deriveChangeUnits(artifact).map((item) => item.unit);
  return { format: CHANGE_INDEX_FORMAT, patch_digest: artifact.patch_digest, units_digest: sha256(units), change_units: units };
};

const lineWithinRange = (line: number, range: ChangeRange | undefined): boolean => Boolean(range && range.lines > 0 && line >= range.start && line < range.start + range.lines);

const lineStatusInHunk = (
  bytes: Buffer,
  unit: ChangeUnit,
  line: number,
  side: "old" | "new",
): ChangeLineStatus | undefined => {
  const oldRange = unit.old_range;
  const newRange = unit.new_range;
  if (unit.kind !== "hunk" || !oldRange || !newRange) return integrity(`Change Unit ${unit.change_unit_id} has invalid hunk ranges`);
  const lines = linesWithin(bytes, 0, bytes.length);
  let oldLine = oldRange.start;
  let newLine = newRange.start;
  let status: ChangeLineStatus | undefined;
  for (const diffLine of lines.slice(1)) {
    const prefix = bytes[diffLine.start];
    if (prefix === 0x20) {
      if ((side === "old" ? oldLine : newLine) === line) status = "context";
      oldLine += 1;
      newLine += 1;
    } else if (prefix === 0x2d) {
      if (side === "old" && oldLine === line) status = "deleted";
      oldLine += 1;
    } else if (prefix === 0x2b) {
      if (side === "new" && newLine === line) status = "added";
      newLine += 1;
    } else if (prefix !== 0x5c) {
      integrity(`Change Unit ${unit.change_unit_id} contains an invalid hunk body`);
    }
  }
  if (oldLine - oldRange.start !== oldRange.lines || newLine - newRange.start !== newRange.lines) {
    integrity(`Change Unit ${unit.change_unit_id} hunk body does not match its header ranges`);
  }
  return status;
};

/**
 * Classify one requested line without changing the persisted hunk-level Change
 * Unit identity. Only an actual addition/deletion returns Change Units; context
 * and file-level changes deliberately expose no line-specific rationale refs.
 */
export const matchChangeLine = (
  artifact: CandidateArtifact,
  fileUnits: ChangeUnit[],
  line: number,
  side: "old" | "new",
): ChangeLineMatch => {
  if (fileUnits.some((unit) => unit.kind === "file")) return { status: "unavailable", change_units: [] };
  const unitsInRange = fileUnits.filter((unit) => lineWithinRange(line, side === "old" ? unit.old_range : unit.new_range));
  if (!unitsInRange.length) return { status: "outside_hunks", change_units: [] };

  const indexedByID = new Map(deriveChangeUnits(artifact).map((item) => [item.unit.change_unit_id, item]));
  const changed: ChangeUnit[] = [];
  let context = false;
  for (const unit of unitsInRange) {
    const indexed = indexedByID.get(unit.change_unit_id);
    if (!indexed) return integrity(`Change Unit ${unit.change_unit_id} does not belong to the Candidate artifact`);
    const status = lineStatusInHunk(indexed.bytes, unit, line, side);
    if (status === "added" || status === "deleted") changed.push(unit);
    else if (status === "context") context = true;
  }
  if (changed.length) return { status: side === "old" ? "deleted" : "added", change_units: changed };
  if (context) return { status: "context", change_units: [] };
  return integrity(`line ${line} is within a Change Unit range but absent from its hunk body`);
};

/**
 * Reconcile author-owned rationale references against the immutable Issue and
 * artifact. Returning problems instead of throwing lets the command Module
 * classify caller mistakes as validation errors while the storage Adapter can
 * classify persisted mismatches as integrity errors.
 */
export const inspectChangeRationaleBindings = (
  submission: CandidateSubmissionInput,
  issueRevision: IssueRevision,
  artifact: CandidateArtifact,
): ChangeRationaleBindingInspection => {
  const changeIndex = indexCandidateChanges(artifact);
  const allUnitIDs = new Set(changeIndex.change_units.map((unit) => unit.change_unit_id));
  if (submission.format === "patchledger.candidate-submission/v1") {
    return {
      change_index: changeIndex,
      problems: [],
      explained_change_unit_ids: [],
      unexplained_change_unit_ids: [...allUnitIDs],
    };
  }

  const problems: string[] = [];
  if (submission.change_index.format !== changeIndex.format) problems.push("change_index.format does not match the derived Change Index");
  if (submission.change_index.patch_digest !== changeIndex.patch_digest) problems.push("change_index.patch_digest does not match the Candidate artifact");
  if (submission.change_index.units_digest !== changeIndex.units_digest) problems.push("change_index.units_digest does not match the derived Change Units");

  const criterionIDs = new Set(
    [...issueRevision.goals, ...issueRevision.constraints].flatMap((target) => target.criteria.map((criterion) => criterion.id)),
  );
  const explained = new Set<string>();
  for (let index = 0; index < submission.change_rationales.length; index += 1) {
    const rationale = submission.change_rationales[index];
    for (const unitID of rationale.change_refs) {
      if (!allUnitIDs.has(unitID)) problems.push(`change_rationales[${index}].change_refs contains unknown Change Unit ${unitID}`);
      else explained.add(unitID);
    }
    for (const target of rationale.target_refs) {
      if (!criterionIDs.has(target.id)) problems.push(`change_rationales[${index}].target_refs contains Criterion ${target.id} outside the bound Issue Revision`);
    }
  }
  const unexplained = [...allUnitIDs].filter((unitID) => !explained.has(unitID));
  if (unexplained.length) problems.push(`change_rationales do not explain ${unexplained.length} Change Unit(s): ${unexplained.join(", ")}`);
  if (!allUnitIDs.size && submission.change_rationales.length) problems.push("change_rationales must be empty when the Candidate artifact has no Change Units");
  return {
    change_index: changeIndex,
    problems,
    explained_change_unit_ids: [...explained].sort(),
    unexplained_change_unit_ids: unexplained,
  };
};
