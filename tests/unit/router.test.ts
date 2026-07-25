import { describe, expect, it } from "vitest";
import { createSyntheticSpecialtyRouter, normalizeSymptomEvidence } from "@/lib/adapters/deterministic";
import { recommendationFromRouting } from "@/lib/core";

describe("synthetic specialty router", () => {
  it("routes supported symptom evidence to the allowlisted specialty", async () => {
    const router = createSyntheticSpecialtyRouter();
    const evidence = normalizeSymptomEvidence("I have a recurring migraine headache");
    const result = await router.route({ evidence });
    expect(result.candidates[0]).toMatchObject({ specialtyId: "neurology", subspecialtyId: "headache-neurology" });
    expect(recommendationFromRouting(result).confidence).toBe("high");
  });

  it("does not score negated terms", async () => {
    const router = createSyntheticSpecialtyRouter();
    const result = await router.route({ evidence: normalizeSymptomEvidence("I have no rash, only tiredness") });
    expect(result.candidates).toEqual([]);
    expect(recommendationFromRouting(result).specialtyId).toBe("primary-care");
  });

  it("handles conversational negation and later affirmative mentions", () => {
    expect(normalizeSymptomEvidence("I don't have a rash")).toEqual([]);
    expect(
      normalizeSymptomEvidence(
        "I had no rash yesterday, but I have a rash today",
      ).map((item) => item.normalizedTerm),
    ).toContain("rash");
  });
});
