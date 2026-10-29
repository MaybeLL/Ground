import { DomainError } from "../src/errors.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDevelopmentMode, resumeDevelopmentMode } from "../src/development-mode.js";

test("user selection wins over platform and saved defaults", () => {
  assert.deepEqual(resolveDevelopmentMode({ argument: "simple", environment: "container", configuration: "container" }),
    { mode: "simple", source: "argument" });
  assert.deepEqual(resolveDevelopmentMode({ environment: "container", configuration: "simple" }),
    { mode: "container", source: "environment" });
  assert.deepEqual(resolveDevelopmentMode({ configuration: "simple" }), { mode: "simple", source: "configuration" });
  assert.equal(resolveDevelopmentMode({}), undefined);
});

test("invalid selected values fail instead of silently falling back", () => {
  assert.throws(() => resolveDevelopmentMode({ argument: "auto", configuration: "simple" }), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && String(error.details.reason).includes("simple or container"));
  assert.throws(() => resolveDevelopmentMode({ environment: "", configuration: "simple" }), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && String(error.details.reason).includes("simple or container"));
  assert.deepEqual(resolveDevelopmentMode({ argument: "simple", environment: "invalid" }), { mode: "simple", source: "argument" });
});

test("resume retains the stored mode and rejects a conflicting explicit request", () => {
  assert.equal(resumeDevelopmentMode("simple"), "simple");
  assert.equal(resumeDevelopmentMode("container", "container"), "container");
  assert.throws(() => resumeDevelopmentMode("simple", "container"), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && String(error.details.reason).includes("new DevRun"));
  assert.throws(() => resumeDevelopmentMode("container", "invalid"), (error: unknown) => error instanceof DomainError && error.code === "VALIDATION_ERROR" && String(error.details.reason).includes("simple or container"));
});
