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

const extractJsonObjects = (text: string): unknown[] => {
  const trimmed = text.trim();
  const candidates: unknown[] = [];

  try {
    candidates.push(JSON.parse(trimmed));
  } catch {}

  for (let start = 0; start < trimmed.length; start += 1) {
    if (trimmed[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let end = start; end < trimmed.length; end += 1) {
      const character = trimmed[end];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }

      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            candidates.push(JSON.parse(trimmed.slice(start, end + 1)));
          } catch {}
          break;
        }
      }
    }
  }

  return candidates;
};

/**
 * The model output remains an untrusted proposal until it passes both schema
 * validation and workflow invariants owned by the application.
 */
export function validateModelDecisionValue(
  value: unknown,
  request: ParsedChatEnhancementRequest,
  confidenceThreshold: number,
): ModelDecisionValidation {
  const parsedDecision = modelDecisionSchema.safeParse(value);
  if (!parsedDecision.success) {
    return { success: false, reason: "invalid_model_output" };
  }

  const decision = parsedDecision.data;

  const isFollowUpStage =
    request.stage === "collecting_symptoms" || request.stage === "asking_follow_ups";

  if (
    decision.nextAction === "recommend_specialist" &&
    decision.specialtyId &&
    request.retrievedCandidates.length > 0 &&
    !request.retrievedCandidates.some((candidate) => candidate.specialtyId === decision.specialtyId)
  ) {
    return { success: false, reason: "invalid_model_output" };
  }

  if (
    decision.nextAction === "ask_follow_up" &&
    !isFollowUpStage
  ) {
    return { success: false, reason: "invalid_model_output" };
  }

  if (
    decision.nextAction === "recommend_specialist" &&
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

export function validateModelDecision(
  text: string,
  request: ParsedChatEnhancementRequest,
  confidenceThreshold: number,
): ModelDecisionValidation {
  const candidates = extractJsonObjects(text);

  for (const candidate of candidates) {
    const validation = validateModelDecisionValue(
      candidate,
      request,
      confidenceThreshold,
    );
    if (validation.success || validation.reason !== "invalid_model_output") {
      return validation;
    }
  }

  return { success: false, reason: "invalid_model_output" };
}
