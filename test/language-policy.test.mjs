import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HUMAN_LANGUAGE,
  PROTOCOL_TERMS,
  LANGUAGE_INSTRUCTION,
  LANGUAGE_POLICY_VERSION,
  buildLanguagePolicy,
  validateLanguagePolicy
} from "../src/i18n/language-policy.js";

const REQUIRED_UNTRANSLATED = [
  "READY",
  "CLAIMED",
  "IN_PROGRESS",
  "BLOCKED",
  "SUCCESS",
  "FAILED",
  "CODE_REVIEW",
  "AUTOMATED_TESTS",
  "ACCEPTANCE_CRITERIA"
];

test("human language is Spanish", () => {
  assert.equal(HUMAN_LANGUAGE, "es");
});

test("PROTOCOL_TERMS is frozen and lists every machine-readable value the ticket names", () => {
  assert.ok(Object.isFrozen(PROTOCOL_TERMS));
  for (const term of REQUIRED_UNTRANSLATED) {
    assert.ok(PROTOCOL_TERMS.includes(term), `expected PROTOCOL_TERMS to include ${term}`);
  }
});

test("LANGUAGE_INSTRUCTION tells the runtime to answer in Spanish", () => {
  assert.match(LANGUAGE_INSTRUCTION, /español/i);
  // covers question / blocker / summary / explanation
  assert.match(LANGUAGE_INSTRUCTION, /question/);
  assert.match(LANGUAGE_INSTRUCTION, /context/);
  assert.match(LANGUAGE_INSTRUCTION, /impact/);
  assert.match(LANGUAGE_INSTRUCTION, /summary/);
});

test("LANGUAGE_INSTRUCTION forbids translating enums/states/checks/fields and names them", () => {
  assert.match(LANGUAGE_INSTRUCTION, /NO traduzcas/i);
  for (const term of REQUIRED_UNTRANSLATED) {
    assert.ok(LANGUAGE_INSTRUCTION.includes(term), `instruction should name ${term}`);
  }
});

test("buildLanguagePolicy returns a frozen, secret-free structured policy", () => {
  const p = buildLanguagePolicy();
  assert.ok(Object.isFrozen(p));
  assert.equal(p.version, LANGUAGE_POLICY_VERSION);
  assert.equal(p.humanLanguage, "es");
  assert.equal(p.instruction, LANGUAGE_INSTRUCTION);
  assert.deepEqual(p.doNotTranslate, PROTOCOL_TERMS);
  assert.deepEqual(Object.keys(p).sort(), [
    "doNotTranslate",
    "humanLanguage",
    "instruction",
    "version"
  ]);
});

test("validateLanguagePolicy accepts the canonical policy", () => {
  const { valid, errors } = validateLanguagePolicy(buildLanguagePolicy());
  assert.ok(valid, JSON.stringify(errors));
});

test("validateLanguagePolicy rejects a wrong / missing / incomplete policy", () => {
  assert.ok(!validateLanguagePolicy(null).valid);
  assert.ok(!validateLanguagePolicy({ humanLanguage: "en" }).valid);
  assert.ok(
    !validateLanguagePolicy({
      humanLanguage: "es",
      instruction: "answer in english",
      doNotTranslate: PROTOCOL_TERMS
    }).valid
  );
  const missingTerms = validateLanguagePolicy({
    humanLanguage: "es",
    instruction: LANGUAGE_INSTRUCTION,
    doNotTranslate: ["READY"]
  });
  assert.ok(!missingTerms.valid);
  assert.ok(missingTerms.errors.some(e => e.includes("IN_PROGRESS")));
});
