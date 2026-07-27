import { describe, expect, it } from "vitest";

/**
 * Proves the test runner, TypeScript transform, and path aliases work.
 * Replaced by real tests as Task 3 onward land.
 */
describe("test harness", () => {
  it("runs TypeScript tests", () => {
    const sum = (a: number, b: number): number => a + b;
    expect(sum(2, 3)).toBe(5);
  });
});
