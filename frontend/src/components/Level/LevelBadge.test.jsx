// The badge is the only place a stage is shown as a picture, and the interface
// never prints a stage number, so these cover the two things that carry the
// meaning: that every stage looks different, and that the drawing advances.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import LevelBadge from "./LevelBadge.jsx";

const render = (level, props = {}) =>
  renderToStaticMarkup(<LevelBadge level={level} size={64} {...props} />);

const facetCount = (svg) => (svg.match(/<polygon/g) ?? []).length;

describe("growth-stage diamonds", () => {
  const rendered = Array.from({ length: 21 }, (_, i) => render(i + 1));

  it("renders every growth stage", () => {
    expect(rendered).toHaveLength(21);
    for (const svg of rendered) expect(svg.startsWith("<svg")).toBe(true);
  });

  it("gives every growth stage a visually distinct stone", () => {
    // Twenty-one different stages must be twenty-one different pictures; if two
    // collide, advancing would look like nothing happened.
    expect(new Set(rendered).size).toBe(21);
  });

  it("cuts more facets into the stone as the stages advance", () => {
    expect(facetCount(rendered[0])).toBeLessThan(facetCount(rendered[9]));
    expect(facetCount(rendered[9])).toBeLessThan(facetCount(rendered[20]));
  });

  it("leaves the earliest stages uncut", () => {
    // Carbon and Rough have no crown facets, which is what makes them read as
    // raw stone rather than as a small brilliant.
    const uncut = facetCount(rendered[0]);
    const cut = facetCount(rendered[5]);
    expect(cut).toBeGreaterThan(uncut);
  });

  it("gives the later stages their fire", () => {
    // The glow filter is what separates a polished stone from a dull one.
    expect(rendered[0]).not.toContain("feGaussianBlur");
    expect(rendered[20]).toContain("feGaussianBlur");
  });

  it("names the stage rather than numbering it", () => {
    const named = render(12, { name: "Solitaire" });
    expect(named).toContain('aria-label="Solitaire growth stage"');
    expect(named).not.toMatch(/aria-label="[^"]*\d/);
    expect(render(12)).toContain('aria-label="Growth stage"');
  });

  it("clamps out-of-range stages instead of rendering nothing", () => {
    for (const level of [0, -5, 99, null, undefined, NaN]) {
      const svg = renderToStaticMarkup(<LevelBadge level={level} size={32} />);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain("aria-label");
    }
  });

  it("scales without redrawing", () => {
    for (const size of [14, 32, 128]) {
      expect(render(9, { size })).toContain(`width="${size}"`);
    }
  });
});
