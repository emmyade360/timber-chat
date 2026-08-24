import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import LevelBadge from "/home/oreon/Documents/Projects/timber-chat/frontend/src/components/Level/LevelBadge.jsx";

describe("growth-stage badges", () => {
  const rendered = Array.from({ length: 21 }, (_, i) =>
    renderToStaticMarkup(<LevelBadge level={i + 1} size={64} />));

  it("renders every growth stage", () => {
    expect(rendered).toHaveLength(21);
    for (const svg of rendered) expect(svg.startsWith("<svg")).toBe(true);
  });

  it("gives every growth stage a visually distinct badge", () => {
    // The whole point of the parametric approach is 21 different badges; if two
    // collide, a promotion would look like nothing happened.
    expect(new Set(rendered).size).toBe(21);
  });

  it("adds a growth ring per tier up to the cap", () => {
    const rings = (svg) => (svg.match(/<circle/g) ?? []).length;
    expect(rings(rendered[0])).toBeLessThan(rings(rendered[4]));
    expect(rings(rendered[4])).toBeLessThan(rings(rendered[9]));
  });

  it("names the stage rather than numbering it", () => {
    // The interface never shows a stage number, so the badge must not smuggle
    // one back in through its accessible name.
    const named = renderToStaticMarkup(<LevelBadge level={12} size={32} name="Heartwood" />);
    expect(named).toContain('aria-label="Heartwood growth stage"');
    expect(named).not.toMatch(/aria-label="[^"]*\d/);

    const unnamed = renderToStaticMarkup(<LevelBadge level={12} size={32} />);
    expect(unnamed).toContain('aria-label="Growth stage"');
  });

  it("clamps out-of-range stages instead of rendering nothing", () => {
    for (const level of [0, -5, 99, null, undefined, NaN]) {
      const svg = renderToStaticMarkup(<LevelBadge level={level} size={32} />);
      expect(svg.startsWith("<svg")).toBe(true);
      expect(svg).toContain("aria-label");
    }
  });

  it("reserves facets for the top two tiers", () => {
    const facets = (svg) => (svg.match(/<line\s/g) ?? []).length;
    expect(facets(rendered[18])).toBe(0);
    expect(facets(rendered[19])).toBeGreaterThan(0);
    expect(facets(rendered[20])).toBeGreaterThan(0);
  });

  it("gives the final stage its crystal", () => {
    expect(rendered[20]).toContain("<polygon");
    expect(rendered[19]).not.toContain("<polygon");
  });

  it("labels each badge for screen readers", () => {
    expect(rendered[11]).toContain('aria-label="Growth stage"');
  });
});
