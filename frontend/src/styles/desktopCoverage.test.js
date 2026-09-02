// Guards the defect Phase 0 repairs.
//
// 27 feature classes were declared only inside `@media (max-width: 899px)`, so
// at desktop widths the Vault, the Profile screen and the theme picker rendered
// with User-Agent defaults -- the Vault's only control looked like a raw
// `<button>`. Nothing caught it: the markup was correct, so RTL passed, and
// jsdom applies no stylesheet at all, so axe passed too.
//
// This reads the stylesheet directly rather than rendering anything, because
// the defect is "a rule does not exist at this width", which is a property of
// the file. It keeps working as a guard while the design system is built, and
// is deleted with `index.css` in Phase 7.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../index.css", import.meta.url), "utf8");

/**
 * Blank out comments before analysing, preserving every offset so positions
 * still line up with the original file. Without this a comment that merely
 * *mentions* `@media (max-width: 899px)` is parsed as a real block -- which is
 * exactly what happened while writing this, and it silently swallowed the rest
 * of the stylesheet.
 */
const css = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => " ".repeat(comment.length));

/** Classes that must be styled at >= 900px, taken from the JSX that uses them. */
const DESKTOP_CLASSES = [
  "timber-header", "timber-header-mark", "timber-header-lock",
  "vault-screen", "vault-intro", "vault-eyebrow", "vault-actions", "vault-action",
  "vault-action-icon", "vault-chevron", "vault-note",
  "profile-screen", "profile-actions", "profile-action-row", "profile-avatar-edit",
  "profile-reference-hero", "profile-row-chevron", "profile-toggle",
  "theme-choice", "theme-choice--active",
  "chat-action-sheet", "chat-header-back", "chat-header-extra", "chat-header-overflow",
  "chat-list-compose", "chat-list-mark", "composer-record",
];

const DESKTOP_WIDTH = 900;

/**
 * Character ranges of `@media` blocks that cannot match a desktop viewport,
 * found by brace matching so nested blocks are handled.
 */
function phoneOnlyRanges(source) {
  const ranges = [];
  const media = /@media([^{]*)\{/g;
  let match;
  while ((match = media.exec(source)) !== null) {
    const query = match[1];
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    // A `max-width` below the desktop breakpoint can never apply at >= 900px.
    const cap = /max-width:\s*(\d+)px/.exec(query);
    if (cap && Number(cap[1]) < DESKTOP_WIDTH) ranges.push([match.index, end]);
  }
  return ranges;
}

const PHONE_ONLY = phoneOnlyRanges(css);

const isPhoneOnly = (index) => PHONE_ONLY.some(([start, end]) => index > start && index < end);

/** Every position where the class is used as a selector, not as a substring. */
function selectorPositions(className) {
  const positions = [];
  const pattern = new RegExp(`\\.${className.replace(/[-]/g, "\\-")}(?![\\w-])`, "g");
  let match;
  while ((match = pattern.exec(css)) !== null) positions.push(match.index);
  return positions;
}

describe("desktop style coverage", () => {
  it.each(DESKTOP_CLASSES)("styles .%s at desktop widths", (className) => {
    const positions = selectorPositions(className);
    expect(positions.length, `.${className} is never declared`).toBeGreaterThan(0);
    expect(
      positions.some((index) => !isPhoneOnly(index)),
      `.${className} is declared only inside a phone-only @media block, so it has no styling at >= ${DESKTOP_WIDTH}px`,
    ).toBe(true);
  });
});

describe("mobile form controls", () => {
  // Anything under 16px makes iOS Safari zoom the viewport when the field takes
  // focus, which then leaves the layout scrolled sideways.
  it("never sets a font-size below 16px on an input", () => {
    const offenders = [];
    for (const [, selector, body] of css.matchAll(/([^{}]*(?:input|glass-input|textarea)[^{}]*)\{([^}]*)\}/gi)) {
      const size = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(body);
      if (size && Number(size[1]) < 16) offenders.push(`${selector.trim()} -> ${size[1]}px`);
    }
    expect(offenders, "these fields will zoom on focus in iOS Safari").toEqual([]);
  });
});
