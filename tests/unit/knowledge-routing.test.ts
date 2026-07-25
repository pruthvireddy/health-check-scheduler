import { describe, expect, it } from "vitest";

import { createHybridSpecialtyRouter, normalizeSymptomEvidence } from "@/lib/adapters/deterministic";
import { validateModelDecision } from "@/lib/adapters/llm";
import { chatEnhancementRequestSchema } from "@/lib/llm/contracts";

describe("knowledge-backed routing and grounded LLM constraints", () => {
  it("uses compiled symptom-term mapping in hybrid routing and emits ranked candidates", async () => {
    const router = createHybridSpecialtyRouter();
    const evidence = normalizeSymptomEvidence("I have nausea and vomiting");

    const result = await router.route({ evidence });
    expect(result.backend).toBe("csv");
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].specialtyId).toBe("gastroenterology");
    expect(result.candidates[0].matchedTerms.length).toBeGreaterThan(0);
  });

  it("requires model specialty recommendations to stay within retrieved candidates", () => {
    const request = chatEnhancementRequestSchema.parse({
      conversationId: "conversation-1",
      stage: "recommending_specialist",
      recentMessages: [{ role: "user", content: "I still have nausea" }],
      approvedEvidence: [],
      retrievedCandidates: [
        {
          specialtyId: "gastroenterology",
          confidence: 0.82,
          matchedTerms: ["nausea", "vomiting"],
        },
      ],
      answeredQuestionTypes: [],
      followUpCount: 2,
    });

    const invalid = validateModelDecision(
      JSON.stringify({
        extractedEvidence: [
          {
            normalizedTerm: "nausea",
            originalText: "still nauseated",
            temporality: "current",
          },
        ],
        nextAction: "recommend_specialist",
        specialtyId: "dermatology",
        confidence: 0.9,
      }),
      request,
      0.7,
    );

    expect(invalid).toEqual({
      success: false,
      reason: "invalid_model_output",
    });
  });
});
