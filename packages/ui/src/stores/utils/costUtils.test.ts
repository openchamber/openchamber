import { describe, expect, test } from "bun:test";

import { sumAssistantMessageCosts } from "./costUtils";

describe("sumAssistantMessageCosts", () => {
  test("sums positive assistant cost values from direct SDK messages", () => {
    const cost = sumAssistantMessageCosts([
      { role: "assistant", cost: 0.12 },
      { role: "user", cost: 10 },
      { role: "assistant", cost: 0.3 },
    ]);

    expect(cost).toBe(0.42);
  });

  test("sums positive assistant cost values from wrapped UI messages", () => {
    const cost = sumAssistantMessageCosts([
      { info: { role: "assistant", cost: 0.0042 } },
      { info: { role: "assistant", cost: 0 } },
      { info: { role: "assistant", cost: -1 } },
      { info: { role: "assistant", cost: Number.NaN } },
    ]);

    expect(cost).toBe(0.0042);
  });
});
