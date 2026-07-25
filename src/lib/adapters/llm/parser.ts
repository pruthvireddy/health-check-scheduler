import {
  modelDecisionSchema,
  type ModelDecision,
  type ParsedChatEnhancementRequest,
} from "@/lib/llm/contracts";

export type ModelDecisionValidation =
  | { success: true; decision: ModelDecision }
  | {
      success: false;
      reason:
        | "invalid_model_output"
        | "duplicate_follow_up"
        | "follow_up_limit_reached"
        | "low_confidence";
    };

const extractJsonObject = (text: string): unknown => {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");

    if (start < 0 || end <= start) {
      throw new Error("No JSON object was returned.");
    }

    return JSON.parse(trimmed.slice(start, end + 1));
  }
};

/**
 * The model output remains an untrusted proposal until it passes both schema
 * validation and workflow invariants owned by the application.
 */
export function validateModelDecision(
  text: string,
  request: ParsedChatEnhancementRequest,
  confidenceThreshold: number,
): ModelDecisionValidation {
  let parsedJson: unknown;

  try {
    parsedJson = extractJsonObject(text);
  } catch {
    return { success: false, reason: "invalid_model_output" };
  }

  const parsedDecision = modelDecisionSchema.safeParse(parsedJson);
  if (!parsedDecision.success) {
    return { success: false, reason: "invalid_model_output" };
  }

  const decision = parsedDecision.data;

  // An uncertain model may still escalate a concern. It can never use a low
  // confidence value to suppress deterministic fallback or clear urgency.
  if (
    decision.nextAction !== "urgent_review" &&
    decision.confidence < confidenceThreshold
  ) {
    return { success: false, reason: "low_confidence" };
  }

  if (
    decision.nextAction === "ask_follow_up" &&
    request.followUpCount >= 4
  ) {
    return { success: false, reason: "follow_up_limit_reached" };
  }

  if (
    decision.nextAction === "ask_follow_up" &&
    decision.questionType &&
    request.answeredQuestionTypes.includes(decision.questionType)
  ) {
    return { success: false, reason: "duplicate_follow_up" };
  }

  return { success: true, decision };
}
