import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../src/errors.js";
import { normalizeRemote } from "../src/git.js";
import { newUUIDv7 } from "../src/identity.js";
import { backends, backendSkip, openLedger } from "./backends.js";
import { testAgent } from "./fixture.js";

// A Repository must resolve the same way whichever transport a clone uses.  The
// ledger stores one canonical spelling; a clone reached over another transport
// still denotes the same host and path.  `resolveRepository` receives already
// normalized canonical remotes, exactly as `discoverRepository` produces them.

for (const backend of backends) test(`${backend}: repository resolution and registration are transport-agnostic`, { skip: backendSkip(backend) }, async () => {
  const f = await openLedger(backend);
  try {
    const registered = (remote: string) => f.module.registerRepository({ operation_id: newUUIDv7(), attribution: testAgent, canonical_remote: remote });

    // The fixture registers ssh://git@example.test/team/repo; an https clone of
    // the same host and path resolves to it, and a scp-like clone too.
    assert.equal((await f.module.resolveRepository([normalizeRemote("https://example.test/team/repo")])).id, f.repository.repository_id);
    assert.equal((await f.module.resolveRepository([normalizeRemote("ssh://git@example.test/team/repo")])).id, f.repository.repository_id);
    assert.equal((await f.module.resolveRepository([normalizeRemote("git@example.test:team/repo")])).id, f.repository.repository_id);
    assert.equal((await f.module.resolveRepository([normalizeRemote("ssh://other@example.test:2222/team/repo")])).id, f.repository.repository_id);

    // A different host or path is a different (unregistered) Repository.
    await assert.rejects(f.module.resolveRepository([normalizeRemote("https://other.test/team/repo")]), (error) => error instanceof DomainError && error.code === "REPOSITORY_NOT_RESOLVED");
    await assert.rejects(f.module.resolveRepository([normalizeRemote("https://example.test/team/other")]), (error) => error instanceof DomainError && error.code === "REPOSITORY_NOT_RESOLVED");

    // Registering an https spelling of the same host and path resolves to the
    // existing Repository instead of creating a duplicate, and writes no alias.
    const before = (await f.module.listRepositories()).resources.length;
    const again = await registered("https://example.test/team/repo");
    assert.equal(again.result.repository_id, f.repository.repository_id);
    assert.equal((await f.module.listRepositories()).resources.length, before);
    assert.deepEqual(await f.module.activeRepositoryRemotes(f.repository.repository_id), ["ssh://git@example.test/team/repo"]);

    // The reverse direction: an ssh clone of a Repository registered over https.
    const suffix = newUUIDv7().slice(-8);
    const https = await registered(`https://mirror.test/team/only-https-${suffix}`);
    assert.equal((await f.module.resolveRepository([`ssh://git@mirror.test/team/only-https-${suffix}`])).id, https.result.repository_id);

    assert.equal((await f.store.inspectIntegrity()).report.valid, true);
  } finally { await f.close(); }
});

for (const backend of backends) test(`${backend}: alias-add and move refuse a remote another Repository already matches`, { skip: backendSkip(backend) }, async () => {
  const f = await openLedger(backend);
  try {
    const a = await f.module.registerRepository({ operation_id: newUUIDv7(), attribution: testAgent, canonical_remote: "ssh://git@conflict.test/team/a" });
    const b = await f.module.registerRepository({ operation_id: newUUIDv7(), attribution: testAgent, canonical_remote: "ssh://git@conflict.test/team/b" });
    // A remote whose key (host + path) equals B's active canonical is refused on A.
    await assert.rejects(f.module.addRepositoryAlias({ operation_id: newUUIDv7(), repository_id: a.result.repository_id, expected_version: a.result.version, remote: "https://conflict.test/team/b", attribution: testAgent }),
      (error) => error instanceof DomainError && error.code === "VALIDATION_ERROR");
    // A redundant alias on A matching A's own remotes is allowed.
    const redundant = await f.module.addRepositoryAlias({ operation_id: newUUIDv7(), repository_id: a.result.repository_id, expected_version: a.result.version, remote: "https://conflict.test/team/a", attribution: testAgent });
    assert.equal(redundant.version, a.result.version + 1);
    // move is refused the same way.
    await assert.rejects(f.module.moveRepository({ operation_id: newUUIDv7(), repository_id: a.result.repository_id, expected_version: redundant.version, canonical_remote: "https://conflict.test/team/b", attribution: testAgent }),
      (error) => error instanceof DomainError && error.code === "VALIDATION_ERROR");
  } finally { await f.close(); }
});
