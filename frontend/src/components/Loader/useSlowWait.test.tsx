// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useSlowWait } from "./useSlowWait.js";

function Probe({ active, afterMs }: { active: boolean; afterMs?: number }) {
  const slow = useSlowWait(active, afterMs);
  return <p>{slow ? "slow" : "quick"}</p>;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("explaining a long wait", () => {
  it("stays quiet for a wait that ends quickly", () => {
    const { rerender } = render(<Probe active />);
    expect(screen.getByText("quick")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3_000); });
    // Leading with an apology for a wait that is usually over in a moment
    // makes the app feel slower than it is.
    expect(screen.getByText("quick")).toBeInTheDocument();
    rerender(<Probe active={false} />);
  });

  it("explains itself once the wait is genuinely long", () => {
    render(<Probe active />);
    act(() => { vi.advanceTimersByTime(6_000); });
    expect(screen.getByText("slow")).toBeInTheDocument();
  });

  it("starts hopeful again on a retry", () => {
    const { rerender } = render(<Probe active />);
    act(() => { vi.advanceTimersByTime(6_000); });
    expect(screen.getByText("slow")).toBeInTheDocument();

    rerender(<Probe active={false} />);
    rerender(<Probe active />);
    // A fresh attempt should not inherit the previous one's pessimism.
    expect(screen.getByText("quick")).toBeInTheDocument();
  });

  it("never escalates a wait that is not running", () => {
    render(<Probe active={false} />);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByText("quick")).toBeInTheDocument();
  });
});
