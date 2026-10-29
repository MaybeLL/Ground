import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../src/errors.js";
import { newUUIDv7 } from "../src/identity.js";
import { backends, backendSkip, openLedger } from "./backends.js";
import { testAgent } from "./fixture.js";

// Repository remotes are the one place the engines store different keys: engines
// that cannot index an unbounded remote key on a digest, the others on the remote.
// Every alias operation must behave identically either way.

const remoteOf = (suffix: string): string => `ssh://git@example.test/team/${suffix}`;

for (const backend of backends) test(`${backend}: repository aliases and moves behave the same whichever key the engine uses`, { skip: backendSkip(backend) }, async () => {
  const f = await openLedger(backend);
  try {
    const registered = (suffix: string) => f.module.registerRepository({ operation_id: newUUIDv7(), attribution: testAgent, canonical_remote: remoteOf(suffix) });
    const base = (await registered(`alias-base-${newUUIDv7().slice(-8)}`)).result;
    const other = (await registered(`alias-other-${newUUIDv7().slice(-8)}`)).result;
    const alias = remoteOf(`alias-extra-${newUUIDv7().slice(-8)}`);
    const command = (version: number, remote: string) => ({ operation_id: newUUIDv7(), repository_id: base.repository_id, expected_version: version, remote, attribution: testAgent });

    // add -> the alias resolves to its repository
    const added = await f.module.addRepositoryAlias(command(base.version, alias));
    assert.equal(added.version, base.version + 1);
    assert.equal((await f.store.read((tx) => tx.findRepositoryByRemote(alias))).id, base.repository_id);
    assert.deepEqual((await f.module.activeRepositoryRemotes(base.repository_id)).includes(alias), true);

    // an alias that already belongs to another repository is refused, not stolen
    await assert.rejects(f.module.addRepositoryAlias({ ...command(added.version, base.canonical_remote), repository_id: other.repository_id, expected_version: other.version }), (error) => error instanceof DomainError && error.code === "VALIDATION_ERROR");

    // retire -> it stops resolving, but stays reserved for the same repository
    const retired = await f.module.retireRepositoryAlias(command(added.version, alias));
    await assert.rejects(f.store.read((tx) => tx.findRepositoryByRemote(alias)), (error) => error instanceof DomainError && error.code === "NOT_FOUND");
    assert.equal((await f.module.activeRepositoryRemotes(base.repository_id)).includes(alias), false);

    // re-adding a retired alias reactivates it
    const readded = await f.module.addRepositoryAlias(command(retired.version, alias));
    assert.equal((await f.store.read((tx) => tx.findRepositoryByRemote(alias))).id, base.repository_id);

    // move the canonical remote onto an alias this repository already owns
    const moved = await f.module.moveRepository({ operation_id: newUUIDv7(), repository_id: base.repository_id, expected_version: readded.version, canonical_remote: alias, attribution: testAgent });
    assert.equal(moved.canonical_remote, alias);
    assert.equal((await f.store.read((tx) => tx.getRepository(base.repository_id))).canonical_remote, alias);

    // moving onto another repository's remote is refused
    await assert.rejects(f.module.moveRepository({ operation_id: newUUIDv7(), repository_id: base.repository_id, expected_version: moved.version, canonical_remote: other.canonical_remote, attribution: testAgent }), (error) => error instanceof DomainError && error.code === "VALIDATION_ERROR");

    // a stale version is a conflict on every engine
    await assert.rejects(f.module.addRepositoryAlias(command(base.version, remoteOf(`alias-stale-${newUUIDv7().slice(-8)}`))), (error) => error instanceof DomainError && error.code === "VERSION_CONFLICT");

    assert.equal((await f.store.inspectIntegrity()).report.valid, true);
  } finally { await f.close(); }
});
