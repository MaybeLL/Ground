import { closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { safeTree, safeTreeWrite } from './safe-tree.js';

/** Resolve through directory descriptors: candidate-controlled links must never
 * turn private grader cleanup into a host filesystem operation. */
function inParent<T>(root: string, target: string, work: (fd: number, name: string) => T): T {
  const parts = target.split('/');
  if (isAbsolute(target) || parts.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) throw new Error('private grader target must be relative');
  const descriptors: number[] = [];
  try {
    let fd = safeTree.openDirectory(root); descriptors.push(fd);
    for (const part of parts.slice(0, -1)) { fd = safeTree.openEntry(fd, part, true); descriptors.push(fd); }
    return work(fd, parts.at(-1)!);
  } finally { for (const fd of descriptors.reverse()) closeSync(fd); }
}
export function assertPrivateGraderTargets(root: string, targets: string[]): void {
  if (new Set(targets).size !== targets.length) throw new Error('private grader targets must be unique');
  for (const target of targets) inParent(root, target, (fd, name) => {
    if (safeTree.directoryEntries(fd).includes(name)) throw new Error('private grader target already exists in candidate');
  });
}
export function removePrivateGraderFiles(root: string, targets: string[]): void {
  for (const target of targets) inParent(root, target, (fd, name) => {
    if (safeTree.directoryEntries(fd).includes(name)) safeTreeWrite.removeEntry(fd, name, false);
  });
}
