import { execFileSync } from "node:child_process";
import { cpSync, closeSync, fstatSync, lstatSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
import { join, dirname, posix, isAbsolute } from "node:path";
import { privateDirectory, safeReadOpened, atomicPrivateWrite, digestBytes } from "./runtime-files.js";
import { safeTree } from "./safe-tree.js";
import { validation } from "./errors.js";
import { sha256 } from "./canonical-json.js";
import { isEnvironmentDefinitionPath, isPrivateGroundsPath } from "./grounds-exclude.js";

export function trustedGit(cwd: string, args: string[], trim = true): string {
  const output = execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.safecrlf=false",
      ...args,
    ],
    {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: dirname(cwd),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        LC_ALL: "C",
      },
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120000,
    },
  );
  return trim ? output.trim() : output;
}

export interface Checkout {
  source_clone?: string;
  directory: string;
  trusted: string;
  baseline: string;
  repository: string;
}

function baselineGitlinks(repository: string, oid: string): string[] {
  return trustedGit(repository, ["ls-tree", "-r", "-z", oid], false)
    .split("\0")
    .filter(Boolean)
    .filter((entry) => entry.startsWith("160000 commit "))
    .map((entry) => entry.slice(entry.indexOf("\t") + 1));
}

function fdIdentity(fd: number): string {
  const stat = fstatSync(fd, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

function openPinnedDirectory(parentFd: number, name: string, field: string): number {
  const expected = safeTree.entryStat(parentFd, name);
  if (expected.kind !== "directory")
    throw validation(field, "expected a real directory: " + name);
  let fd: number;
  try {
    fd = safeTree.openEntry(parentFd, name, true);
  } catch {
    throw validation(field, "directory changed before no-follow open: " + name);
  }
  if (fdIdentity(fd) !== expected.identity) {
    closeSync(fd);
    throw validation(field, "directory changed during no-follow open: " + name);
  }
  return fd;
}

function verifyContainerGit(directory: string, baseline: string): void {
  const rootFd = safeTree.openDirectory(directory);
  try {
    const gitFd = openPinnedDirectory(rootFd, ".git", "git");
    try {
      const head = safeTree.entryStat(gitFd, "HEAD");
      if (head.kind !== "file") throw validation("git", "invalid container HEAD");
      const headFd = safeTree.openEntry(gitFd, "HEAD", false);
      try {
        if (fdIdentity(headFd) !== head.identity ||
            safeReadOpened(headFd, 4096).toString().trim() !== baseline)
          throw validation("git", "container HEAD moved from Baseline");
      } finally {
        closeSync(headFd);
      }
      if (safeTree.directoryEntries(gitFd).includes("commondir"))
        throw validation("git", "external Git metadata is unsupported");
      const objectsFd = openPinnedDirectory(gitFd, "objects", "git");
      try {
        const infoFd = openPinnedDirectory(objectsFd, "info", "git");
        try {
          if (safeTree.directoryEntries(infoFd).includes("alternates"))
            throw validation("git", "external Git metadata is unsupported");
        } finally {
          closeSync(infoFd);
        }
      } finally {
        closeSync(objectsFd);
      }
    } finally {
      closeSync(gitFd);
    }
  } finally {
    closeSync(rootFd);
  }
}

function ensureEmptyGitlinksPinned(rootFd: number, gitlinks: string[]): void {
  for (const path of gitlinks) {
    const parts = path.split("/");
    let current = rootFd;
    let complete = true;
    try {
      for (const part of parts) {
        if (!safeTree.directoryEntries(current).includes(part)) {
          complete = false;
          break;
        }
        const next = openPinnedDirectory(current, part, "repository");
        if (current !== rootFd) closeSync(current);
        current = next;
      }
      if (complete && current !== rootFd && safeTree.directoryEntries(current).length)
        throw validation("repository", "initialized or modified submodule/gitlink is unsupported: " + path);
    } finally {
      if (current !== rootFd) closeSync(current);
    }
  }
}

function validateSnapshotLinks(
  entries: Record<string, string>,
  directories: Set<string>,
): void {
  const links = new Map(Object.entries(entries)
    .filter(([, value]) => value.startsWith("link:"))
    .map(([key, value]) => [key, value.slice(5)]));
  for (const key of links.keys()) {
    const base = posix.dirname(key) === "." ? [] : posix.dirname(key).split("/");
    const pending = [links.get(key)!];
    const visited = new Set<string>([key]);
    while (pending.length) {
      const value = pending.shift()!;
      if (isAbsolute(value))
        throw validation("capture", "symlink escapes the project: " + key);
      const components = value.split("/");
      for (let index = 0; index < components.length; index++) {
        const part = components[index];
        if (!part || part === ".") continue;
        if (part === "..") {
          if (!base.length)
            throw validation("capture", "symlink escapes the project: " + key);
          base.pop();
          continue;
        }
        const candidate = [...base, part].join("/");
        if (candidate === ".git" || candidate.startsWith(".git/") ||
            candidate === ".grounds" || candidate.startsWith(".grounds/"))
          throw validation("capture", "symlink targets reserved metadata: " + key);
        if (links.has(candidate)) {
          if (visited.has(candidate))
            throw validation("capture", "symlink cycle: " + key);
          visited.add(candidate);
          pending.unshift(...components.slice(index + 1).filter(Boolean));
          pending.unshift(links.get(candidate)!);
          break;
        }
        const more = index < components.length - 1 || pending.length > 0;
        if (more && !directories.has(candidate))
          throw validation("capture", "symlink target is unavailable: " + key);
        base.push(part);
      }
    }
    const endpoint = base.join("/");
    if (!endpoint || (!Object.hasOwn(entries, endpoint) && !directories.has(endpoint)))
      throw validation("capture", "symlink target is unavailable: " + key);
  }
}

export function freezeCheckout(
  checkout: Checkout,
  target: string,
  hostTrusted = false,
  listPaths?: () => string[],
): { directory: string; manifest: string } {
  if (!hostTrusted) {
    verifyContainerGit(checkout.directory, checkout.baseline);
  } else if (
    trustedGit(checkout.directory, ["rev-parse", "HEAD"]) !== checkout.baseline
  )
    throw validation("git", "host HEAD changed");
  const paths = listPaths ? listPaths() : trustedGit(
    checkout.trusted,
    [
      "--work-tree=" + checkout.directory,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    false,
  )
    .split("\0")
    .filter(Boolean);
  if (paths.some(isPrivateGroundsPath))
    throw validation("capture", "reserved .grounds path is tracked");
  const gitlinks = baselineGitlinks(checkout.trusted, checkout.baseline);
  const included = new Set(paths),
    ancestors = new Set<string>();
  for (const path of paths) {
    let parent = dirname(path);
    while (parent !== ".") {
      ancestors.add(parent);
      parent = dirname(parent);
    }
  }
  privateDirectory(target);
  const before: Record<string, string> = Object.create(null);
  let total = 0,
    count = 0;
  const scan = (
    sourceFd: number,
    rel: string,
    dest?: string,
  ): { entries: Record<string, string>; directories: Set<string> } => {
    const found: Record<string, string> = Object.create(null);
    const directories = new Set<string>();
    for (const name of safeTree.directoryEntries(sourceFd).sort()) {
      if (!rel && name === ".git") continue;
      const key = rel ? rel + "/" + name : name;
      if (!included.has(key) && !ancestors.has(key)) continue;
      let st: ReturnType<typeof safeTree.entryStat>;
      try {
        st = safeTree.entryStat(sourceFd, name);
      } catch {
        throw validation("capture", "entry changed during no-follow scan: " + key);
      }
      if ((key === ".grounds" || key === ".grounds/environments") && st.kind !== "directory")
        throw validation("capture", "environment declaration ancestors must be real directories");
      if (isEnvironmentDefinitionPath(key) && st.kind !== "file")
        throw validation("capture", "environment declarations must be regular files");
      if (st.kind === "link") {
        let value: string;
        try {
          value = safeTree.entryLink(sourceFd, name);
          if (safeTree.entryStat(sourceFd, name).identity !== st.identity)
            throw new Error("changed");
        } catch {
          throw validation("capture", "symlink changed during capture: " + key);
        }
        found[key] = "link:" + value;
        if (dest) {
          mkdirSync(dirname(join(dest, key)), { recursive: true });
          symlinkSync(value, join(dest, key));
        }
        continue;
      }
      if (st.kind === "directory") {
        if (name === ".git")
          throw validation("capture", "nested Git metadata unsupported");
        let childFd: number;
        try {
          childFd = safeTree.openEntry(sourceFd, name, true);
        } catch {
          throw validation("capture", "directory changed before no-follow open: " + key);
        }
        try {
          if (fdIdentity(childFd) !== st.identity)
            throw validation("capture", "directory changed during capture: " + key);
          directories.add(key);
          const nested = scan(childFd, key, dest);
          Object.assign(found, nested.entries);
          for (const directory of nested.directories) directories.add(directory);
        } finally {
          closeSync(childFd);
        }
        continue;
      }
      if (st.kind !== "file" || st.nlink !== 1)
        throw validation("capture", "unsupported special or hard-linked file");
      if (++count > 100000 || (total += st.size) > 256 * 1024 * 1024)
        throw validation(
          "capture",
          "file snapshot exceeds 256 MiB or 100000 files",
        );
      let fileFd: number;
      try {
        fileFd = safeTree.openEntry(sourceFd, name, false);
      } catch {
        throw validation("capture", "file changed before no-follow open: " + key);
      }
      let bytes: Buffer;
      try {
        const opened = fstatSync(fileFd, { bigint: true });
        if (`${opened.dev}:${opened.ino}` !== st.identity ||
            Number(opened.size) !== st.size || Number(opened.mode) !== st.mode)
          throw validation("capture", "file changed before no-follow read: " + key);
        bytes = safeReadOpened(fileFd, 64 * 1024 * 1024);
      } finally {
        closeSync(fileFd);
      }
      if (
        name === ".gitattributes" &&
        /(filter|working-tree-encoding)\s*=/.test(bytes.toString())
      )
        throw validation(
          "capture",
          "external filters and encodings require separate support",
        );
      found[key] =
        (st.mode & 0o111 ? "executable:" : "regular:") + digestBytes(bytes);
      if (dest) {
        atomicPrivateWrite(join(dest, key), bytes);
        chmodSync(join(dest, key), st.mode & 0o111 ? 0o755 : 0o644);
      }
    }
    return { entries: found, directories };
  };
  const projectFd = safeTree.openDirectory(checkout.directory);
  let after: Record<string, string>;
  try {
    ensureEmptyGitlinksPinned(projectFd, gitlinks);
    const initial = scan(projectFd, "", target);
    Object.assign(before, initial.entries);
    validateSnapshotLinks(before, initial.directories);
    count = 0;
    total = 0;
    const final = scan(projectFd, "");
    after = final.entries;
    validateSnapshotLinks(after, final.directories);
    ensureEmptyGitlinksPinned(projectFd, gitlinks);
    const root = lstatSync(checkout.directory);
    if (!root.isDirectory() || root.isSymbolicLink() ||
        fdIdentity(projectFd) !== `${BigInt(root.dev)}:${BigInt(root.ino)}`)
      throw validation("capture", "project directory changed during capture");
  } finally {
    closeSync(projectFd);
  }
  const afterPaths = listPaths ? listPaths() : trustedGit(
    checkout.trusted,
    [
      "--work-tree=" + checkout.directory,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
    ],
    false,
  )
    .split("\0")
    .filter(Boolean);
  if (sha256(paths) !== sha256(afterPaths) || sha256(before) !== sha256(after))
    throw validation("capture", "source changed during capture");
  // Git keeps an unchanged gitlink in the index, but its empty worktree
  // directory must also exist for the established submodule safety check.
  for (const path of gitlinks)
    mkdirSync(join(target, path), { recursive: true, mode: 0o700 });
  // Only the trusted metadata is used by subsequent captureArtifact; no container config/index is copied.
  cpSync(join(checkout.trusted, ".git"), join(target, ".git"), {
    recursive: true,
    dereference: false,
  });
  trustedGit(target, ["reset", "--mixed", checkout.baseline]);
  return { directory: target, manifest: sha256(before) };
}

/** Run the established capture algorithm with an isolated Git environment and trusted metadata. */
export function captureFrozen(
  directory: string,
  baseline: string,
): import("./domain.js").CandidateArtifact {
  return withGitRunner(
    (cwd, args, indexPath, input) =>
      execFileSync(
        "git",
        [
          "--no-replace-objects",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.attributesFile=/dev/null",
          "-c",
          "diff.external=",
          "-c",
          "core.autocrlf=false",
          ...args,
        ],
        {
          cwd,
          input,
          env: {
            PATH: process.env.PATH,
            HOME: dirname(directory),
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_NO_LAZY_FETCH: "1",
            GIT_TERMINAL_PROMPT: "0",
            ...(indexPath ? { GIT_INDEX_FILE: indexPath } : {}),
          },
          timeout: 120000,
          maxBuffer: 64 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        },
      ),
    () => captureArtifact(directory, baseline),
  );
}
import { withGitRunner } from "./git-command.js";
import { captureArtifact } from "./git.js";
