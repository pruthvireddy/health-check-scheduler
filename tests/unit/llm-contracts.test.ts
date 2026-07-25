import { describe, expect, it } from "vitest";

import {
  chatEnhancementRequestSchema,
  chatEnhancementResponseSchema,
  followUpPromptFor,
  modelDecisionSchema,
  syntheticFallbackResponse,
} from "@/lib/llm";

const evidence = {
  id: "evidence-1",
  normalizedTerm: "rash",
  originalText: "An itchy rash",
  temporality: "current" as const,
  source: "context_file" as const,
  sourceLabel: "visit-note.txt",
  userApproved: true,
};

describe("hybrid chat contracts", () => {
  it("keeps only explicitly approved, non-negated context evidence", () => {
    const parsed = chatEnhancementRequestSchema.parse({
      conversationId: "conversation-1",
      stage: "asking_follow_ups",
      recentMessages: [{ role: "user", content: "I have an itchy rash" }],
      approvedEvidence: [
        evidence,
        { ...evidence, id: "evidence-2", normalizedTerm: "headache", userApproved: false },
        { ...evidence, id: "evidence-3", normalizedTerm: "fever", negated: true },
      ],
      answeredQuestionTypes: ["onset"],
      followUpCount: 1,
    });

    expect(parsed.approvedEvidence).toEqual([evidence]);
  });

  it("rejects unbounded requests and model values outside the allowlists", () => {
    const oversizedRequest = chatEnhancementRequestSchema.safeParse({
      conversationId: "conversation-1",
      stage: "collecting_symptoms",
      recentMessages: [{ role: "user", content: "x".repeat(2_001) }],
      approvedEvidence: [],
      answeredQuestionTypes: [],
      followUpCount: 0,
    });
    expect(oversizedRequest.success).toBe(false);

    const inventedSpecialty = modelDecisionSchema.safeParse({
      extractedEvidence: [],
      nextAction: "recommend_specialist",
      specialtyId: "space-medicine",
      confidence: 0.9,
    });
    expect(inventedSpecialty.success).toBe(false);
  });

  it("requires the decision field associated with each actionable response", () => {
    expect(
      modelDecisionSchema.safeParse({
        extractedEvidence: [],
        nextAction: "ask_follow_up",
        confidence: 0.8,
      }).success,
    ).toBe(false);

    expect(
      modelDecisionSchema.safeParse({
        extractedEvidence: [],
        nextAction: "recommend_specialist",
        confidence: 0.8,
      }).success,
    ).toBe(false);
  });

  it("builds a schema-valid local fallback and uses application-owned prompts", () => {
    const fallback = syntheticFallbackResponse("Provider timeout");

    expect(chatEnhancementResponseSchema.parse(fallback)).toEqual(fallback);
    expect(fallback).toMatchObject({
      mode: "synthetic_fallback",
      nextAction: "ask_follow_up",
      confidence: 0,
      fallbackReason: "Provider timeout",
    });
    expect(followUpPromptFor("severity")).toBe(
      "How severe are the symptoms on a scale from 1 to 10?",
    );
  });

  it("accepts only a complete, allowlisted LLM response", () => {
    const response = {
      mode: "llm",
      modelVersion: "provider/model-name",
      extractedEvidence: [
        {
          normalizedTerm: "rash",
          originalText: "itchy rash",
          temporality: "current",
        },
      ],
      nextAction: "recommend_specialist",
      specialtyId: "dermatology",
      confidence: 0.86,
      explanation: "Skin symptoms are the strongest current concern.",
    };

    expect(chatEnhancementResponseSchema.parse(response)).toEqual(response);
  });
});
