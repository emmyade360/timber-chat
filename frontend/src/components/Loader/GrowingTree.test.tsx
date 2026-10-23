// The loader has two jobs beyond looking right: say what is being waited for,
// and keep moving while the main thread is busy. Both are testable; the second
// only by checking that nothing animates a property that would stall.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import GrowingTree from "./GrowingTree.js";

// Read from the working directory, not `import.meta.url`: under jsdom that is
// an http URL rather than a file one.
const css = readFileSync("src/components/Loader/GrowingTree.module.css", "utf8");

type Point = readonly [number, number];

/** Mirrors BRANCHES in GrowingTree.tsx; the drift test below keeps them honest. */
const BRANCHES: { from: Point; to: Point }[] = [
  { from: [60, 88], to: [30, 74] },
  { from: [60, 80], to: [92, 66] },
  { from: [60, 70], to: [34, 52] },
  { from: [60, 64], to: [88, 44] },
  { from: [60, 58], to: [60, 34] },
];

describe("the waiting picture", () => {
  it("announces what is being waited for", () => {
    render(<GrowingTree label="Waking the server…" />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Waking the server…");
    // Polite: a wait must not interrupt whatever is already being read out.
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("still has an accessible name with no caption", () => {
    render(<GrowingTree />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });

  it("hides the drawing from assistive technology", () => {
    const { container } = render(<GrowingTree label="Growing" />);
    const svg = container.querySelector("svg");
    // The caption carries the meaning; the picture would only be noise.
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
  });

  it("is sized by attribute, not by an inline style", () => {
    const { container } = render(<GrowingTree size={200} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "200");
    expect(svg?.getAttribute("style")).toBeNull();
  });

  it("draws one person per branch", () => {
    const { container } = render(<GrowingTree />);
    expect(container.querySelectorAll("path")).toHaveLength(BRANCHES.length);
  });
});

describe("motion", () => {
  /**
   * The loader is on screen while key derivation blocks the main thread. Only
   * `transform` and `opacity` can be animated off it; anything else would stall
   * at precisely the moment the user needs to see progress.
   */
  it("animates nothing that would stall on a busy main thread", () => {
    const animated = new Set<string>();
    for (const [, body] of css.matchAll(/@keyframes[^{]*\{([\s\S]*?)\n\}/g)) {
      if (!body) continue;
      // Declarations sit inline inside each percentage block, so anchor on the
      // punctuation that precedes a property rather than on the line start.
      for (const [, property] of body.matchAll(/[{;]\s*([a-z-]+)\s*:/g)) {
        if (property) animated.add(property);
      }
    }
    expect(animated.size).toBeGreaterThan(0);
    expect([...animated].sort()).toEqual(["opacity", "transform"]);
  });

  it("stops moving when the reader asks for less motion", () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}\n/.exec(css);
    expect(block, "no reduced-motion block").not.toBeNull();
    // The sway and the travelling pulses are the vestibular triggers, so the
    // rule has to reach every animated class rather than a token few.
    for (const cls of ["tree", "trunk", "branch", "person", "ring", "pulse"]) {
      expect(block?.[1]).toContain(`.${cls}`);
    }
    expect(block?.[1]).toContain("animation: none");
  });

  it("stays visible when the system overrides colours", () => {
    expect(css).toContain("forced-colors: active");
    expect(css).toContain("CanvasText");
  });
});

describe("geometry", () => {
  /**
   * The stylesheet cannot read the coordinates out of the component, so it
   * repeats them as transform origins and pulse offsets. This is the guard that
   * moving a branch cannot leave a pulse travelling toward where it used to be.
   */
  it.each(BRANCHES.map((b, i) => [i + 1, b] as const))(
    "branch %i grows from the trunk and its pulse returns there",
    (n, { from, to }) => {
      expect(css).toContain(`.branch:nth-of-type(${n}) { transform-origin: ${from[0]}px ${from[1]}px;`);
      expect(css).toContain(`.person:nth-of-type(${n}) { transform-origin: ${to[0]}px ${to[1]}px;`);

      const pulse = new RegExp(`\\.pulse:nth-of-type\\(${n}\\) \\{ --dx: (-?\\d+)px;\\s+--dy: (-?\\d+)px;`).exec(css);
      expect(pulse, `no pulse offsets for branch ${n}`).not.toBeNull();
      const [fromX, fromY] = from;
      const [toX, toY] = to;
      expect(Number(pulse?.[1])).toBe(fromX - toX);
      expect(Number(pulse?.[2])).toBe(fromY - toY);
    },
  );
});
