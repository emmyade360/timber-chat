#!/usr/bin/env node
// Single-source-of-truth versioning for the whole app.
//
// The backend and the frontend ship together and a browser only ever talks to
// one relay, so they carry one number. `VERSION` at the repo root is that
// number; every manifest is a copy of it, and this script is the only thing
// allowed to write them.
//
// The next version is derived from the Conventional Commits since the last
// release tag:
//
//   BREAKING CHANGE / type!:  -> major
//   feat:                     -> minor
//   anything else             -> patch
//
// The final rule is deliberate. A commit with no recognised prefix still moves
// the patch digit, so every push to main produces a distinct, installable
// version -- there is no such thing as two different builds claiming to be the
// same release.
//
// No dependencies: this runs in CI on the Node that is already there, and the
// release path is not somewhere to add supply chain surface.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION_FILE = join(ROOT, "VERSION");
const CHANGELOG_FILE = join(ROOT, "CHANGELOG.md");
const TAG_PREFIX = "v";

/** Conventional Commit types, in the order they appear in the changelog. */
const SECTIONS = [
  ["feat", "Features"],
  ["fix", "Fixes"],
  ["perf", "Performance"],
  ["refactor", "Refactoring"],
  ["docs", "Documentation"],
  ["test", "Tests"],
  ["build", "Build"],
  ["ci", "CI"],
  ["chore", "Chores"],
  ["style", "Style"],
  ["revert", "Reverts"],
];

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

function currentVersion() {
  if (!existsSync(VERSION_FILE)) throw new Error("VERSION file is missing.");
  const raw = readFileSync(VERSION_FILE, "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(raw)) {
    throw new Error(`VERSION must be a bare semver like 1.4.2, found "${raw}".`);
  }
  return raw;
}

/** The last release tag, or null on a repository that has never released. */
function lastTag() {
  try {
    // stdio silences the expected "No names found" on a repo with no tags.
    return execFileSync("git", ["describe", "--tags", "--abbrev=0", "--match", `${TAG_PREFIX}*`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Commits since `from`, newest first.
 *
 * The record separator is an ASCII unit separator rather than a newline so a
 * commit body containing blank lines cannot be mistaken for a record boundary.
 */
function commitsSince(from) {
  const range = from ? `${from}..HEAD` : "HEAD";
  const log = git("log", range, "--no-merges", "--format=%H%x1f%s%x1f%b%x1e");
  return log
    .split("\x1e")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, subject, body = ""] = entry.split("\x1f");
      return { hash, subject, body };
    });
}

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s+(?<description>.+)$/;

/** Parse one commit into the fields the bump and the changelog need. */
export function parseCommit({ subject, body = "" }) {
  const match = HEADER.exec(subject);
  // A footer of `BREAKING CHANGE:` is the other half of the spec, and is the
  // form used when the break needs a paragraph of explanation.
  const breakingFooter = /^BREAKING[ -]CHANGE:/m.test(body);
  if (!match) {
    return { type: null, scope: null, breaking: breakingFooter, description: subject };
  }
  const { type, scope, breaking, description } = match.groups;
  return {
    type,
    scope: scope ?? null,
    breaking: Boolean(breaking) || breakingFooter,
    description,
  };
}

/** major | minor | patch for a set of parsed commits. */
export function bumpFor(commits) {
  if (commits.some((commit) => commit.breaking)) return "major";
  if (commits.some((commit) => commit.type === "feat")) return "minor";
  return "patch";
}

export function nextVersion(version, bump) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * Replace a version string in a file, failing loudly if the anchor is not
 * found. A silent no-op here would ship a build whose manifest disagrees with
 * its tag, which is the exact failure this whole script exists to prevent.
 */
function rewrite(relativePath, pattern, replacement) {
  const path = join(ROOT, relativePath);
  const before = readFileSync(path, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before) {
    throw new Error(`Could not update the version in ${relativePath}; its format changed.`);
  }
  writeFileSync(path, after);
}

/** Every file that carries the version. Lockfiles included, or installs break. */
export function writeVersion(version) {
  writeFileSync(VERSION_FILE, `${version}\n`);

  // Cargo: the manifest, and the package's own entry in the lockfile. Without
  // the lockfile, `cargo build --locked` refuses to start.
  rewrite("backend/Cargo.toml", /^version = "\d+\.\d+\.\d+"$/m, `version = "${version}"`);
  rewrite(
    "backend/Cargo.lock",
    /(\[\[package\]\]\nname = "timber-chat-backend"\nversion = )"\d+\.\d+\.\d+"/,
    `$1"${version}"`,
  );

  // npm: the manifest, and both places the lockfile repeats it. `npm ci` fails
  // when the two disagree.
  // Anchored to a top-level key so a dependency's version can never be hit.
  rewrite("frontend/package.json", /^(  "version": )"\d+\.\d+\.\d+"/m, `$1"${version}"`);
  rewrite(
    "frontend/package-lock.json",
    /("name":\s*"frontend",\s*\n\s*"version":\s*)"\d+\.\d+\.\d+"/g,
    `$1"${version}"`,
  );
}

function changelogSection(version, commits, previousTag) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`## ${version} — ${date}`, ""];

  const breaking = commits.filter((commit) => commit.breaking);
  if (breaking.length) {
    lines.push("### Breaking changes", "");
    for (const commit of breaking) lines.push(entryLine(commit));
    lines.push("");
  }

  for (const [type, heading] of SECTIONS) {
    const matching = commits.filter((commit) => commit.type === type && !commit.breaking);
    if (!matching.length) continue;
    lines.push(`### ${heading}`, "");
    for (const commit of matching) lines.push(entryLine(commit));
    lines.push("");
  }

  // Commits with no recognised prefix are still listed. Leaving them out would
  // make the changelog quietly incomplete, which is worse than untidy.
  const other = commits.filter(
    (commit) => !commit.breaking && !SECTIONS.some(([type]) => type === commit.type),
  );
  if (other.length) {
    lines.push("### Other", "");
    for (const commit of other) lines.push(entryLine(commit));
    lines.push("");
  }

  if (previousTag) {
    lines.push(`Compared with [${previousTag}](../../compare/${previousTag}...${TAG_PREFIX}${version}).`, "");
  }
  return lines.join("\n");
}

const entryLine = (commit) =>
  `- ${commit.scope ? `**${commit.scope}:** ` : ""}${commit.description} (${commit.hash.slice(0, 7)})`;

function prependChangelog(section) {
  const preamble = "# Changelog\n\nEvery release is generated from the Conventional Commits on `main`.\n";
  const existing = existsSync(CHANGELOG_FILE)
    ? readFileSync(CHANGELOG_FILE, "utf8").replace(preamble, "").trimStart()
    : "";
  writeFileSync(CHANGELOG_FILE, `${preamble}\n${section}\n${existing}`.trimEnd() + "\n");
}

function main() {
  const mode = process.argv[2] ?? "apply";
  const previousTag = lastTag();

  // Bootstrap. With no tag there is no "since last release", and deriving a
  // bump from the entire history would pick up prefixes written long before
  // this convention existed. Instead, plant a flag at whatever VERSION already
  // says and let the next push be the first real release.
  if (!previousTag) {
    const version = currentVersion();
    console.log("released=true");
    console.log("bootstrap=true");
    console.log(`previous=${version}`);
    console.log("bump=none");
    console.log(`version=${version}`);
    console.log(`tag=${TAG_PREFIX}${version}`);
    return;
  }

  const commits = commitsSince(previousTag).map((commit) => ({
    ...commit,
    ...parseCommit(commit),
  }));

  if (!commits.length) {
    // Nothing new to release. Say so on stdout and exit clean, so a workflow
    // can branch on it rather than treating an empty range as a failure.
    console.log("released=false");
    return;
  }

  const from = currentVersion();
  const bump = bumpFor(commits);
  const version = nextVersion(from, bump);

  if (mode === "apply") {
    writeVersion(version);
    prependChangelog(changelogSection(version, commits, previousTag));
  }

  console.log("released=true");
  console.log("bootstrap=false");
  console.log(`previous=${from}`);
  console.log(`bump=${bump}`);
  console.log(`version=${version}`);
  console.log(`tag=${TAG_PREFIX}${version}`);
}

// Importable for tests; only the CLI path touches the working tree.
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
