import { describe, expect, it } from "vitest";

import { validateModelDecision } from "@/lib/adapters/llm";
import { chatEnhancementRequestSchema } from "@/lib/llm";

const request = (
  overrides: Partial<{
    answeredQuestionTypes: Array<
      "onset" | "duration" | "severity" | "progression" | "associated_symptoms"
    >;
    followUpCount: number;
  }> = {},
) =>
  chatEnhancementRequestSchema.parse({
    conversationId: "conversation-1",
    stage: "asking_follow_ups",
    recentMessages: [{ role: "user", content: "I have an itchy rash" }],
    approvedEvidence: [],
    answeredQuestionTypes: [],
    followUpCount: 0,
    ...overrides,
  });

const validDecision = {
  extractedEvidence: [
    {
      normalizedTerm: "rash",
      originalText: "itchy rash",
      temporality: "current",
    },
  ],
  nextAction: "ask_follow_up",
  questionType: "severity",
  confidence: 0.84,
  explanation: "Severity would help select the next routine step.",
};

describe("untrusted model decision validation", () => {
  it("accepts a complete decision embedded in provider prose", () => {
    const result = validateModelDecision(
      `Model response:\n${JSON.stringify(validDecision)}`,
      request(),
      0.7,
    );

    expect(result).toMatchObject({
      success: true,
      decision: {
        nextAction: "ask_follow_up",
        questionType: "severity",
        confidence: 0.84,
      },
    });
  });

  it("rejects malformed provider output", () => {
    expect(validateModelDecision("not JSON", request(), 0.7)).toEqual({
      success: false,
      reason: "invalid_model_output",
    });
  });

  it("rejects a decision below the application confidence threshold", () => {
    expect(
      validateModelDecision(
        JSON.stringify({ ...validDecision, confidence: 0.69 }),
        request(),
        0.7,
      ),
    ).toEqual({ success: false, reason: "low_confidence" });
  });

  it("rejects a follow-up type that was already answered", () => {
    expect(
      validateModelDecision(
        JSON.stringify(validDecision),
        request({ answeredQuestionTypes: ["severity"] }),
        0.7,
      ),
    ).toEqual({ success: false, reason: "duplicate_follow_up" });
  });

  it("rejects any additional question at the follow-up limit", () => {
    expect(
      validateModelDecision(
        JSON.stringify(validDecision),
        request({
          answeredQuestionTypes: [
            "onset",
            "duration",
            "progression",
            "associated_symptoms",
          ],
          followUpCount: 4,
        }),
        0.7,
      ),
    ).toEqual({ success: false, reason: "follow_up_limit_reached" });
  });
});
