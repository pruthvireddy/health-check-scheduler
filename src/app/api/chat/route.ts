import { screenForUrgentRedFlags } from "@/lib/core/safety";
import {
  getLlmEnhancementConfig,
  requestHuggingFaceEnhancement,
  safeConversationalLead,
  validateModelDecision,
} from "@/lib/adapters/llm";
import {
  chatEnhancementRequestSchema,
  chatEnhancementResponseSchema,
  syntheticFallbackResponse,
  type ChatEnhancementResponse,
  type ParsedChatEnhancementRequest,
} from "@/lib/llm/contracts";

export const runtime = "nodejs";
export const maxDuration = 30;

const JSON_HEADERS = {
  "Cache-Control": "no-store",
} as const;

const responseJson = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: JSON_HEADERS });

const fallbackStatus = (
  mode: "local" | "hybrid" | "llm-required",
  reason: string,
): number => {
  if (mode !== "llm-required") return 200;
  return reason === "low_confidence" ? 422 : 503;
};

const currentSafetyText = (request: ParsedChatEnhancementRequest): string => {
  const latestUserMessage =
    [...request.recentMessages]
      .reverse()
      .find((message) => message.role === "user")?.content ?? "";
  const approvedCurrentEvidence = request.approvedEvidence
    .filter((evidence) => evidence.temporality === "current")
    .map((evidence) => evidence.originalText);

  return [latestUserMessage, ...approvedCurrentEvidence].join("\n");
};

const urgentResponse = (category: string): ChatEnhancementResponse => ({
  mode: "synthetic_fallback",
  extractedEvidence: [],
  nextAction: "urgent_review",
  confidence: 1,
  explanation:
    "A deterministic safety rule found a possible urgent warning sign. Routine scheduling should stop.",
  fallbackReason: `urgent_screening:${category}`.slice(0, 240),
});

const safeExplanation = (
  response: Pick<
    ChatEnhancementResponse,
    "nextAction" | "questionType" | "specialtyId"
  >,
  request: Pick<
    ParsedChatEnhancementRequest,
    "purpose" | "retrievedCandidates"
  >,
): string => {
  if (response.nextAction === "urgent_review") {
    return "The assistant raised a possible urgent concern. Routine scheduling should stop for a safety review.";
  }

  if (response.nextAction === "ask_follow_up") {
    const topic = (response.questionType ?? "symptoms").replaceAll("_", " ");
    return `A follow-up about ${topic} can clarify the scheduling route.`;
  }

  if (response.nextAction === "phase_transition") {
    return request.purpose === "confirmation"
      ? "The application has completed the local demo reservation."
      : "The application has recorded the scheduling selection and is ready for the next step.";
  }

  const candidate = request.retrievedCandidates.find(
    (item) => item.specialtyId === response.specialtyId,
  );
  const terms = candidate?.matchedTerms?.length
    ? ` matched terms: ${candidate.matchedTerms.slice(0, 3).join(", ")}`
    : "";

  const specialty = (response.specialtyId ?? "primary-care").replaceAll(
    "-",
    " ",
  );
  return `The reported symptom pattern can be routed to ${specialty} for scheduling${terms}. This is not a diagnosis.`;
};

export async function POST(request: Request): Promise<Response> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return responseJson(
      {
        error: {
          code: "invalid_json",
          message: "The request body must be valid JSON.",
        },
      },
      400,
    );
  }

  const parsedRequest = chatEnhancementRequestSchema.safeParse(body);
  if (!parsedRequest.success) {
    return responseJson(
      {
        error: {
          code: "invalid_request",
          message: "The chat enhancement request is invalid.",
        },
      },
      400,
    );
  }

  const input = parsedRequest.data;

  // Safety remains deterministic and runs before any external network call.
  const urgentResult = screenForUrgentRedFlags(currentSafetyText(input));
  if (urgentResult.isUrgent) {
    return responseJson(
      chatEnhancementResponseSchema.parse(
        urgentResponse(urgentResult.category ?? "urgent_warning"),
      ),
    );
  }

  const config = getLlmEnhancementConfig();

  if (config.mode === "local") {
    return responseJson(syntheticFallbackResponse("local_mode"));
  }

  if (!config.apiKey) {
    const fallback = syntheticFallbackResponse("missing_hf_token");
    return responseJson(
      fallback,
      fallbackStatus(config.mode, "missing_hf_token"),
    );
  }

  try {
    const providerResult = await requestHuggingFaceEnhancement(input, config);
    const validation = validateModelDecision(
      providerResult.text,
      input,
      config.confidenceThreshold,
    );

    if (!validation.success) {
      const fallback = syntheticFallbackResponse(validation.reason);
      return responseJson(
        fallback,
        fallbackStatus(config.mode, validation.reason),
      );
    }

    const response = chatEnhancementResponseSchema.parse({
      ...validation.decision,
      conversationalLead: safeConversationalLead(
        validation.decision.conversationalLead,
      ),
      // Never render unrestricted model prose as clinical guidance.
      explanation: safeExplanation(validation.decision, {
        purpose: input.purpose,
        retrievedCandidates: input.retrievedCandidates,
      }),
      mode: "llm",
      modelVersion: providerResult.model,
    });

    return responseJson(response);
  } catch {
    // Do not return provider errors or sensitive request content to the browser.
    const fallback = syntheticFallbackResponse("provider_unavailable");
    return responseJson(
      fallback,
      fallbackStatus(config.mode, "provider_unavailable"),
    );
  }
}
