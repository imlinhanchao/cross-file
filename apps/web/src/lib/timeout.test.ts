import { afterEach, describe, expect, it, vi } from "vitest";
import { startTimeout } from "./timeout.js";

describe("startTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once after the delay", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    startTimeout(1000, onTimeout);
    vi.advanceTimersByTime(999);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents the callback", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const guard = startTimeout(1000, onTimeout);
    guard.cancel();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
