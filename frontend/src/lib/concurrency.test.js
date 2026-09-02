// The bound that stops a reconnect from becoming a thundering herd.

import { describe, expect, it } from "vitest";
import { mapWithLimit } from "./concurrency.js";

describe("mapWithLimit", () => {
  it("never exceeds the limit, and finishes everything", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, index) => index);

    const results = await mapWithLimit(items, 4, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => { setTimeout(resolve, 1); });
      inFlight -= 1;
      return value * 2;
    });

    expect(peak).toBeLessThanOrEqual(4);
    expect(results).toHaveLength(50);
    expect(results.map((entry) => entry.value)).toEqual(items.map((value) => value * 2));
  });

  // One conversation failing to catch up must not abandon the rest.
  it("isolates a failure instead of abandoning the batch", async () => {
    const results = await mapWithLimit([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error("nope");
      return value;
    });

    expect(results.map((entry) => entry.ok)).toEqual([true, false, true]);
    expect(results[1].error.message).toBe("nope");
    expect(results[2].value).toBe(3);
  });

  it("preserves order regardless of completion order", async () => {
    const results = await mapWithLimit([30, 10, 20], 3, async (delay) => {
      await new Promise((resolve) => { setTimeout(resolve, delay); });
      return delay;
    });
    expect(results.map((entry) => entry.value)).toEqual([30, 10, 20]);
  });

  it("handles an empty list without hanging", async () => {
    expect(await mapWithLimit([], 4, async () => 1)).toEqual([]);
  });
});
