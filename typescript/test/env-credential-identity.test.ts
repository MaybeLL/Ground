import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withRuntimeDirectories } from "../src/runtime-files.js";
import { environmentStoreRoot } from "../src/env-store.js";
import { authorizeCredentials, credentialRedactions, injectCredentials, registerCredentialGrant, syncCredentials, type CredentialGrant } from "../src/env-credentials.js";
import { DomainError } from "../src/errors.js";
import { assertContract } from "./schema-fixture.js";
const rejectsFor = (reason: RegExp) => (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && reason.test(String(error.details.reason));

const fixture = async (action: (root: string, grant: CredentialGrant) => void) => {
  const root = mkdtempSync(join(homedir(), "tmp/grounds-env-v5-agent-identity-unit-"));
  try {
    await withRuntimeDirectories({ runtimeHome: join(root, "runtime"), directoryRegistryHome: join(root, "registry") }, () => {
      const source = join(root, "fixture-credential.json");
      writeFileSync(source, JSON.stringify({ tokens: { account_id: "fixture-account" }, auth_mode: "fixture-oauth", scope: "model-only", value: "temporary-unit-value" }), { mode: 0o600 });
      action(root, { name: "model", repository_id: "fixture-repository", environment: "dev", source_file: source, account: "fixture-account", method: "fixture-oauth", access: "model", writeback: true, identity_fields: ["tokens.account_id", "auth_mode"] });
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
};

test("scope-only, account-only and method-only selectors cannot enable credential writeback", async () => fixture((_root, grant) => {
  for (const fields of [["scope"], ["tokens.account_id"], ["auth_mode"]]) {
    assert.throws(() => registerCredentialGrant({ ...grant, identity_fields: fields }), rejectsFor(/bind both the authorized account and authentication method/));
    assert.ok(!existsSync(join(environmentStoreRoot(), "credential-grants.json")), "rejected authorization must not be persisted");
  }
}));

test("nested account and authentication method selectors validate the declared source identity", async () => fixture((_root, grant) => {
  assert.throws(() => registerCredentialGrant({ ...grant, account: "other-account" }), rejectsFor(/account/));
  assert.throws(() => registerCredentialGrant({ ...grant, method: "other-method" }), rejectsFor(/authentication method/));
  assert.doesNotThrow(() => registerCredentialGrant(grant));
}));

test("bound account or method changes cannot write back, and same-identity renewal can", async () => fixture((root, grant) => {
  registerCredentialGrant(grant);
  const bindings = authorizeCredentials({ declarations: [{ name: "model" }], environment: "dev", taskRepositoryId: grant.repository_id, resolvedRepositoryId: grant.repository_id });
  const copies = join(root, "private-copies"); injectCredentials(copies, bindings);
  const original = readFileSync(grant.source_file, "utf8");
  for (const change of ["account", "method"]) {
    const value = JSON.parse(original);
    if (change === "account") value.tokens.account_id = "different-account";
    else value.auth_mode = "different-method";
    writeFileSync(join(copies, "model"), JSON.stringify(value));
    assert.equal(syncCredentials(copies, bindings)[0].sync, "failed");
    assert.equal(readFileSync(grant.source_file, "utf8"), original);
  }
  const refreshed = JSON.parse(original); refreshed.value = "temporary-renewed-value";
  writeFileSync(join(copies, "model"), JSON.stringify(refreshed));
  assert.equal(syncCredentials(copies, bindings)[0].sync, "updated");
  assert.equal(JSON.parse(readFileSync(grant.source_file, "utf8")).value, refreshed.value);
}));

test("damaged private redaction history cannot echo credential bytes in diagnostics", async () => fixture((root, grant) => {
  registerCredentialGrant(grant);
  const bindings = authorizeCredentials({ declarations: [{ name: "model" }], environment: "dev", taskRepositoryId: grant.repository_id, resolvedRepositoryId: grant.repository_id });
  const copies = join(root, "private-copies"); injectCredentials(copies, bindings);
  const secret = "temporary-private-history-value";
  writeFileSync(join(root, "credential-redactions.json"), secret);
  assert.throws(() => credentialRedactions(copies, bindings), error => {
    assert.ok(error instanceof DomainError);
    assert.match(String(error.details.reason), /private redaction history is unreadable/);
    assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
  assert.equal(readFileSync(join(root, "credential-redactions.json"), "utf8"), secret, "failed observation must preserve the private scene");
}));

test("the credential contract requires both identity dimensions only when writeback is enabled", async () => fixture((_root, grant) => {
  const value = { ...grant, repository_id: "01a0b3b8-8271-7225-99ea-1eea0d23f14a" };
  const check = (candidate: unknown) => assertContract("environment.schema.json#/$defs/credentialGrant", candidate);
  assert.doesNotThrow(() => check(value));
  for (const fields of [undefined, [], ["scope"], ["tokens.account_id"], ["auth_mode"]]) {
    const candidate = { ...value, identity_fields: fields };
    if (fields === undefined) delete candidate.identity_fields;
    assert.throws(() => check(candidate));
  }
  const readOnly = { ...value, writeback: false };
  delete readOnly.identity_fields;
  assert.doesNotThrow(() => check(readOnly));
}));
