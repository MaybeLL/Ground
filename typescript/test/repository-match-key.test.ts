import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "../src/errors.js";
import { repositoryMatchKey } from "../src/git.js";

// The match key decides whether two canonical remotes denote the same
// Repository.  It ignores transport (ssh/scp/http(s)/git), SSH username, and
// ssh/git ports; it keeps host and path, and an http(s) non-default port.

const key = (raw: string): string | undefined => repositoryMatchKey(raw);

test("repository match key ignores transport, SSH username and ssh port", () => {
  const expected = key("ssh://gitlab@git.example.test:2222/team/proj");
  assert.equal(expected, key("https://git.example.test/team/proj"));
  assert.equal(expected, key("http://git.example.test/team/proj"));
  assert.equal(expected, key("git://git.example.test/team/proj"));
  assert.equal(expected, key("ssh://other-user@git.example.test/team/proj"));
  assert.equal(expected, key("ssh://git.example.test:22/team/proj"));
});

test("repository match key keeps host and path distinct", () => {
  assert.notEqual(key("https://github.com/a/b"), key("https://git.example.test/a/b"));
  assert.notEqual(key("https://git.example.test/a/b"), key("https://git.example.test/a/c"));
  assert.notEqual(key("https://git.example.test/team/proj"), key("https://git.example.test/team/other"));
});

test("repository match key separates an http(s) non-default port", () => {
  const a = key("https://host.test:8443/team/proj");
  const b = key("https://host.test:9443/team/proj");
  assert.notEqual(a, b);
  // Same host/path/port over http and https are the same key; a different port is not.
  assert.equal(a, key("http://host.test:8443/team/proj"));
  assert.notEqual(a, key("https://host.test/team/proj"));
  // scp-like and ssh ignore the port, so they collapse to host + path only.
  assert.equal(key("ssh://git@host.test:2222/team/proj"), key("ssh://git@host.test:3333/team/proj"));
});

test("repository match key never confuses userinfo with the host", () => {
  // The host is the part after the last '@'; this must not equal a real
  // git.example.test remote, and must key on evil.example.
  assert.equal(key("https://git.example.test@evil.example/team/proj"), key("https://evil.example/team/proj"));
  assert.notEqual(key("https://git.example.test@evil.example/team/proj"), key("https://git.example.test/team/proj"));
});

test("repository match key returns undefined for a string with no scheme or path", () => {
  assert.equal(key("not-a-remote"), undefined);
  assert.equal(key("ssh://host.test"), undefined);
  assert.equal(key("ssh://host.test/"), undefined);
});
