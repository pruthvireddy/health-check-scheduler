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

  it("finds a valid balanced JSON object after unrelated reasoning JSON", () => {
    const result = validateModelDecision(
      `Reasoning metadata: {"attempt":1}\nFinal:\n\`\`\`json\n${JSON.stringify(validDecision)}\n\`\`\``,
      request(),
      0.7,
    );

    expect(result).toMatchObject({
      success: true,
      decision: {
        nextAction: "ask_follow_up",
        questionType: "severity",
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

  it("accepts the constrained phase-copy action for scheduling transitions", () => {
    const phaseRequest = chatEnhancementRequestSchema.parse({
      conversationId: "conversation-1",
      stage: "selecting_date",
      recentMessages: [{ role: "user", content: "I selected a 20-minute visit" }],
      approvedEvidence: [],
      retrievedCandidates: [],
      answeredQuestionTypes: [],
      followUpCount: 4,
      purpose: "scheduling_transition",
      transitionContext: "The user selected a 20-minute visit.",
    });
    const result = validateModelDecision(
      JSON.stringify({
        extractedEvidence: [],
        nextAction: "phase_transition",
        confidence: 1,
        conversationalLead: "That selection is saved.",
        explanation: "The application can show the next scheduling step.",
      }),
      phaseRequest,
      0.7,
    );

    expect(result).toMatchObject({
      success: true,
      decision: { nextAction: "phase_transition" },
    });
  });

  it("rejects phase-copy output for a clinical navigation request", () => {
    expect(
      validateModelDecision(
        JSON.stringify({
          extractedEvidence: [],
          nextAction: "phase_transition",
          confidence: 1,
          explanation: "The application can show the next step.",
        }),
        request(),
        0.7,
      ),
    ).toEqual({ success: false, reason: "invalid_model_output" });
  });
});
