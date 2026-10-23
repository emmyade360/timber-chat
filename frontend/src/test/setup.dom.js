// Browser-shaped test environment. Only loaded by the `dom` project; the
// crypto and storage suites never pay for any of it.

import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import axe from "axe-core";

// This entry point registers the matchers *and* augments Vitest's `Assertion`
// type, so `toHaveAttribute` type-checks as well as runs. Extending `expect`
// with the raw matcher map does only the first.
import "@testing-library/jest-dom/vitest";

// `globals` is off, so Testing Library's own auto-cleanup never registers.
// Without this every test would inherit the previous test's DOM.
afterEach(cleanup);

/**
 * jsdom ships no matchMedia. `useIsDesktop` and `useTheme` both read it during
 * render, so a missing implementation is a crash rather than a wrong answer.
 * Tests override `window.matchMedia` when they care about the viewport.
 */
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

// The message list scrolls itself to the newest message on mount.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

/**
 * `await expect(container).toHaveNoAxeViolations()`.
 *
 * Written against axe-core directly rather than pulling in vitest-axe, which
 * has not kept pace with Vitest 4. The failure message lists the rule, the
 * impact, and the offending markup, because "1 violation" is not actionable.
 */
expect.extend({
  async toHaveNoAxeViolations(received, options = {}) {
    const results = await axe.run(received, {
      // Colour contrast needs real layout and painted pixels; jsdom has
      // neither, so it reports nothing useful here. It is covered in the
      // browser pass instead.
      rules: { "color-contrast": { enabled: false } },
      ...options,
    });

    if (results.violations.length === 0) {
      return { pass: true, message: () => "expected accessibility violations, found none" };
    }

    const detail = results.violations
      .map((violation) => {
        const nodes = violation.nodes.map((node) => `      ${node.html}`).join("\n");
        return `  [${violation.impact ?? "unknown"}] ${violation.id}: ${violation.help}\n${nodes}`;
      })
      .join("\n");

    return {
      pass: false,
      message: () => `expected no accessibility violations, found ${results.violations.length}:\n${detail}`,
    };
  },
});
