// The release script decides what version real users receive, and it runs
// unattended on every push. These cover the parts that would silently ship a
// wrong number rather than fail loudly.

// Uses the Node test runner rather than vitest: the release path must be
// runnable without installing the frontend's dependencies.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bumpFor, nextVersion, parseCommit } from "./version.mjs";

const parse = (subject, body = "") => parseCommit({ subject, body });

/** Assert that `actual` contains at least the keys and values of `expected`. */
function assertMatches(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual[key], value, `expected ${key} to be ${JSON.stringify(value)}`);
  }
}

describe("conventional commit parsing", () => {
  it("reads type, scope and description", () => {
    assertMatches(parse("feat(chat): three-state receipts"), {
      type: "feat",
      scope: "chat",
      breaking: false,
      description: "three-state receipts",
    });
  });

  it("treats a bare subject as an unclassified change rather than dropping it", () => {
    assertMatches(parse("read receipt"), {
      type: null,
      scope: null,
      breaking: false,
      description: "read receipt",
    });
  });

  it("recognises both spellings of a breaking change", () => {
    assert.equal(parse("feat!: drop v1 envelopes").breaking, true);
    assert.equal(parse("feat(api)!: drop v1 envelopes").breaking, true);
    assert.equal(parse("fix: tidy", "BREAKING CHANGE: envelope v1 is gone").breaking, true);
    assert.equal(parse("fix: tidy", "BREAKING-CHANGE: envelope v1 is gone").breaking, true);
  });

  it("does not mistake a colon in prose for a conventional header", () => {
    assert.equal(parse("Note: this is not conventional").type, null);
    // A capitalised word is not a valid type, so it must not be parsed as one.
    assert.equal(parse("Fix: capitalised type").type, null);
  });

  it("only honours a breaking footer at the start of a line", () => {
    assert.equal(parse("fix: tidy", "mentions BREAKING CHANGE: inline").breaking, false);
  });
});

describe("choosing the bump", () => {
  const commits = (...subjects) => subjects.map((subject) => parse(subject));

  it("takes the highest signal present", () => {
    assert.equal(bumpFor(commits("fix: a", "feat: b", "feat!: c")), "major");
    assert.equal(bumpFor(commits("fix: a", "feat: b")), "minor");
    assert.equal(bumpFor(commits("fix: a", "docs: b")), "patch");
  });

  it("still bumps patch when nothing follows the convention", () => {
    // This is what makes every push produce a distinct version.
    assert.equal(bumpFor(commits("read receipt", "search")), "patch");
  });
});

describe("advancing the number", () => {
  it("resets the lower digits", () => {
    assert.equal(nextVersion("1.4.2", "major"), "2.0.0");
    assert.equal(nextVersion("1.4.2", "minor"), "1.5.0");
    assert.equal(nextVersion("1.4.2", "patch"), "1.4.3");
  });

  it("carries correctly past nine", () => {
    assert.equal(nextVersion("1.9.9", "minor"), "1.10.0");
    assert.equal(nextVersion("9.9.9", "major"), "10.0.0");
  });
});
