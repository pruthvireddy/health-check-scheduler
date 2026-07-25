import { describe, expect, it } from "vitest";
import { screenForUrgentRedFlags } from "@/lib/core";

describe("urgent red-flag screen", () => {
  it("stops routine scheduling for a curated emergency phrase", () => {
    const result = screenForUrgentRedFlags("I have sudden face drooping and slurred speech");
    expect(result).toMatchObject({ isUrgent: true, category: "possible stroke symptoms" });
    expect(result.guidance).toContain("Call 911");
  });

  it("does not imply safety when no phrase matches", () => {
    expect(screenForUrgentRedFlags("I have an itchy rash on my arm")).toEqual({ isUrgent: false, matchedPhrases: [] });
  });
});
