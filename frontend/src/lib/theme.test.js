import { describe, expect, it } from "vitest";
import { THEME_STORAGE_KEY, applyTheme, normalizeTheme, readTheme, resolvedTheme } from "./theme.js";

describe("theme preference", () => {
  it("uses dark safely for a missing or invalid preference", () => {
    expect(normalizeTheme("sepia")).toBe("dark");
    expect(readTheme({ getItem: () => "sepia" })).toBe("dark");
  });

  it("resolves system and persists a non-sensitive preference", () => {
    const writes = [];
    const target = { dataset: {}, style: {} };
    expect(resolvedTheme("system", false)).toBe("light");
    expect(applyTheme("system", {
      target,
      systemDark: false,
      storage: { setItem: (...entry) => writes.push(entry) },
    })).toBe("light");
    expect(target.dataset.theme).toBe("light");
    expect(writes).toEqual([[THEME_STORAGE_KEY, "system"]]);
  });
});
