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

  it("cuts a different stone for every stage rather than reusing a band", () => {
    // Palettes used to be shared across two or three stages at a time, so
    // advancing often changed nothing you could see. One stone per stage.
    const palettes = rendered.map((svg) => (svg.match(/stop-color="[^"]+"/g) ?? []).join("|"));
    expect(new Set(palettes).size).toBe(21);
  });

  it("widens the glow as the stones get rarer", () => {
    const blur = (svg) => Number(svg.match(/stdDeviation="([\d.]+)"/)?.[1] ?? 0);
    expect(blur(rendered[5])).toBeGreaterThan(0);
    expect(blur(rendered[5])).toBeLessThan(blur(rendered[12]));
    expect(blur(rendered[12])).toBeLessThan(blur(rendered[20]));
  });

  it("saves sparkle, dispersion and shimmer for the top of the ladder", () => {
    // Stage one has to look like something worth leaving behind, and the last
    // stage has to look like an arrival. Each effect switches on separately so
    // the climb keeps giving something new to notice.
    for (const dull of [rendered[0], rendered[4]]) {
      expect(dull).not.toContain("level-badge-spark");
      expect(dull).not.toContain("-prism");
      expect(dull).not.toContain("level-badge-sweep");
    }
    expect(rendered[11]).toContain("level-badge-spark");
    expect(rendered[16]).toContain("level-badge-sweep");
    expect(rendered[17]).toContain("-prism");

    const sparks = (svg) => (svg.match(/level-badge-spark/g) ?? []).length;
    expect(sparks(rendered[11])).toBeLessThan(sparks(rendered[17]));
    expect(sparks(rendered[17])).toBeLessThan(sparks(rendered[20]));
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
