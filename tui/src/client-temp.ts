import { mkdtempSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Only this user's marked TUI sessions are eligible for orphan cleanup. */
export class ClientTemporaryFiles {
  readonly root: string;
  directory?: string;
  private active = new Set<string>();
  constructor(root = join(tmpdir(), `grounds-tui-owned-${process.getuid?.() ?? 'user'}`)) { this.root = root; }
  async open(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error('TUI temporary root must be a private owned directory');
    await this.sweep();
    this.directory = await mkdtemp(join(this.root, 'session-'));
    await writeFile(join(this.directory, 'owner.json'), JSON.stringify({ format: 'grounds.tui-temporary/v1', pid: process.pid, uid: process.getuid?.() ?? null }), { mode: 0o600 });
    return this.directory;
  }
  async sweep(): Promise<void> {
    for (const name of await readdir(this.root)) {
      if (!/^session-[a-zA-Z0-9]+$/.test(name)) continue;
      const directory = join(this.root, name);
      if (directory === this.directory) continue;
      try {
        const info = await lstat(directory), markerInfo = await lstat(join(directory, 'owner.json'));
        if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || !markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 4096) continue;
        const marker = JSON.parse(await readFile(join(directory, 'owner.json'), 'utf8'));
        if (marker.format !== 'grounds.tui-temporary/v1' || marker.uid !== (process.getuid?.() ?? null) || !Number.isSafeInteger(marker.pid) || marker.pid <= 0) continue;
        try { process.kill(marker.pid, 0); } catch (error) {
          // EPERM and unknown liveness are not permission to remove another session.
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') await rm(directory, { recursive: true, force: true });
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    }
    if (this.directory) for (const name of await readdir(this.directory)) {
      if (!/^(qa-draft|eval-write)-[a-zA-Z0-9]+$/.test(name)) continue;
      const directory = join(this.directory, name);
      if (!this.active.has(directory)) await rm(directory, { recursive: true, force: true });
    }
  }
  async request(prefix: 'qa-draft' | 'eval-write'): Promise<string> {
    await this.sweep();
    const directory = mkdtempSync(join(this.directory!, prefix + '-'));
    this.active.add(directory);
    return directory;
  }
  async release(directory: string): Promise<void> { await rm(directory, { recursive: true, force: true }); this.active.delete(directory); }
  async close(): Promise<void> { if (this.directory) await rm(this.directory, { recursive: true, force: true }); this.directory = undefined; this.active.clear(); }
}
