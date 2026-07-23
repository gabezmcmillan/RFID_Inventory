import { test } from "node:test";
import assert from "node:assert/strict";
import { readEnvKey, upsertEnvKey } from "./envfile.mjs";

const KEY = "EXPO_PUBLIC_DEFAULT_SERVER_URL";
const ORIGIN = "https://machine.tailnet.ts.net";

// --- readEnvKey ------------------------------------------------------------

test("readEnvKey: returns value for an active key", () => {
  assert.equal(readEnvKey(`${KEY}=${ORIGIN}`, KEY), ORIGIN);
});

test("readEnvKey: trims surrounding whitespace and one layer of quotes", () => {
  assert.equal(readEnvKey(`${KEY} =  ${ORIGIN}  `, KEY), ORIGIN);
  assert.equal(readEnvKey(`${KEY}="${ORIGIN}"`, KEY), ORIGIN);
  assert.equal(readEnvKey(`${KEY}='${ORIGIN}'`, KEY), ORIGIN);
});

test("readEnvKey: ignores commented-out lines", () => {
  assert.equal(readEnvKey(`# ${KEY}=${ORIGIN}\n`, KEY), null);
  assert.equal(readEnvKey(`#${KEY}=${ORIGIN}`, KEY), null);
});

test("readEnvKey: returns null when absent / empty content / no key", () => {
  assert.equal(readEnvKey("OTHER=1\n", KEY), null);
  assert.equal(readEnvKey("", KEY), null);
  assert.equal(readEnvKey(`${KEY}=v`, ""), null);
});

test("readEnvKey: only the exact key matches (no prefix/substring bleed)", () => {
  assert.equal(readEnvKey(`EXPO_PUBLIC_DEFAULT_SERVER_URL_X=other`, KEY), null);
  assert.equal(readEnvKey(`PREFIX_${KEY}=other`, KEY), null);
});

// --- upsertEnvKey: append --------------------------------------------------

test("upsertEnvKey: appends to empty content", () => {
  assert.equal(upsertEnvKey("", KEY, ORIGIN), `${KEY}=${ORIGIN}`);
});

test("upsertEnvKey: appends a new line preserving comments and other values", () => {
  const content = "# header comment\nOTHER=keep\n# trailing comment\n";
  const out = upsertEnvKey(content, KEY, ORIGIN);
  assert.equal(out, `# header comment\nOTHER=keep\n# trailing comment\n${KEY}=${ORIGIN}\n`);
  assert.equal(readEnvKey(out, "OTHER"), "keep");
  assert.equal(readEnvKey(out, KEY), ORIGIN);
});

test("upsertEnvKey: appends preserving a no-trailing-newline file", () => {
  const content = "OTHER=keep";
  const out = upsertEnvKey(content, KEY, ORIGIN);
  assert.equal(out, `OTHER=keep\n${KEY}=${ORIGIN}`);
});

// --- upsertEnvKey: update in place -----------------------------------------

test("upsertEnvKey: updates an existing active line, preserves others", () => {
  const content = `# comment\n${KEY}=https://old.example.com\nOTHER=keep\n`;
  const out = upsertEnvKey(content, KEY, ORIGIN);
  assert.equal(out, `# comment\n${KEY}=${ORIGIN}\nOTHER=keep\n`);
  assert.equal(readEnvKey(out, "OTHER"), "keep");
});

test("upsertEnvKey: preserves leading whitespace and key spacing up to '='", () => {
  const content = `  ${KEY} = https://old.example.com\n`;
  const out = upsertEnvKey(content, KEY, ORIGIN);
  assert.equal(out, `  ${KEY} =${ORIGIN}\n`);
});

test("upsertEnvKey: does not touch a commented-out copy (appends a new active line)", () => {
  const content = `# ${KEY}=https://old.example.com\nOTHER=keep\n`;
  const out = upsertEnvKey(content, KEY, ORIGIN);
  assert.equal(out, `# ${KEY}=https://old.example.com\nOTHER=keep\n${KEY}=${ORIGIN}\n`);
});

test("upsertEnvKey: idempotent (upsert twice == upsert once)", () => {
  const once = upsertEnvKey("OTHER=keep\n", KEY, ORIGIN);
  const twice = upsertEnvKey(once, KEY, ORIGIN);
  assert.equal(once, twice);
});

// --- field-origin value matching -------------------------------------------

test("field-origin match: readEnvKey equals the discovered origin after upsert", () => {
  const file = upsertEnvKey("# local env\nOTHER=1\n", KEY, ORIGIN);
  assert.equal(readEnvKey(file, KEY), ORIGIN);
});

test("field-origin match: stale value is detected as not-equal", () => {
  const file = `${KEY}=https://stale.tailnet.ts.net\n`;
  assert.notEqual(readEnvKey(file, KEY), ORIGIN);
});

test("field-origin match: missing key is null (not equal)", () => {
  assert.notEqual(readEnvKey("OTHER=1\n", KEY), ORIGIN);
  assert.equal(readEnvKey("OTHER=1\n", KEY), null);
});
