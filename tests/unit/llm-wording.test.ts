import { describe, expect, it } from "vitest";

import { safeConversationalLead } from "@/lib/adapters/llm";

describe("safe model conversational wording", () => {
  it("accepts a short, non-clinical acknowledgement", () => {
    expect(
      safeConversationalLead(
        "That sounds uncomfortable, and the detail you shared is helpful.",
      ),
    ).toBe(
      "That sounds uncomfortable, and the detail you shared is helpful.",
    );
  });

  it.each([
    "Do you also have a fever?",
    "You likely have a skin condition.",
    "You should take medication.",
    "Book an appointment with a dermatologist.",
  ])("rejects medical, instructional, or question wording: %s", (value) => {
    expect(safeConversationalLead(value)).toBeUndefined();
  });
});
