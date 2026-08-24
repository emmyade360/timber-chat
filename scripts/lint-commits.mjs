#!/usr/bin/env node
// Enforce Conventional Commit subjects on a pull request.
//
// This runs on PRs rather than on main, because a PR is the last point where a
// commit message can still be reworded. The release script is deliberately more
// forgiving than this check -- an unrecognised subject still ships as a patch
// rather than blocking a release -- so this is about keeping the changelog
// readable, not about gating deployment.

import { execFileSync } from "node:child_process";

const TYPES = [
  "feat", "fix", "perf", "refactor", "docs", "test",
  "build", "ci", "chore", "style", "revert",
];

const SUBJECT = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9._/-]+\\))?!?: .+`);
const MAX_SUBJECT = 100;

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error("usage: lint-commits.mjs <base-sha> <head-sha>");
  process.exit(2);
}

const log = execFileSync(
  "git",
  ["log", `${base}..${head}`, "--no-merges", "--format=%H%x1f%s%x1e"],
  { encoding: "utf8" },
).trim();

const commits = log
  .split("\x1e")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [hash, subject] = entry.split("\x1f");
    return { hash, subject };
  });

const problems = [];
for (const { hash, subject } of commits) {
  const short = hash.slice(0, 7);
  // A release commit is written by CI and is already in the required form.
  if (subject.startsWith("chore(release):")) continue;
  if (!SUBJECT.test(subject)) {
    problems.push(`${short} ${subject}\n    does not start with "<type>: " or "<type>(scope): "`);
  } else if (subject.length > MAX_SUBJECT) {
    problems.push(`${short} ${subject}\n    subject is ${subject.length} characters; keep it under ${MAX_SUBJECT}`);
  }
}

if (!commits.length) {
  console.log("No commits to check.");
  process.exit(0);
}

if (problems.length) {
  console.error(`${problems.length} of ${commits.length} commit subjects need rewording:\n`);
  for (const problem of problems) console.error(`  ${problem}\n`);
  console.error(`Allowed types: ${TYPES.join(", ")}`);
  console.error("Add ! before the colon, or a BREAKING CHANGE: footer, for a breaking change.");
  console.error("\nReword with:  git rebase -i " + base);
  process.exit(1);
}

console.log(`All ${commits.length} commit subjects follow the convention.`);
