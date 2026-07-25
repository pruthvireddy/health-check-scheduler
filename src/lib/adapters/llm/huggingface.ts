import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, Output } from "ai";

import {
  modelDecisionSchema,
  type ModelDecision,
  type ParsedChatEnhancementRequest,
} from "@/lib/llm/contracts";

import type { LlmEnhancementConfig } from "./config";
import {
  buildEnhancementPrompt,
  ENHANCEMENT_SYSTEM_PROMPT,
} from "./prompt";

export type HuggingFaceEnhancementResult = {
  decision: ModelDecision;
  model: string;
};

/**
 * The provider is instantiated inside the call so the token never enters a
 * client bundle and tests can change environment variables between requests.
 */
export async function requestHuggingFaceEnhancement(
  request: ParsedChatEnhancementRequest,
  config: LlmEnhancementConfig,
): Promise<HuggingFaceEnhancementResult> {
  if (!config.apiKey) {
    throw new Error("Hugging Face token is not configured.");
  }

  const huggingFace = createOpenAICompatible({
    name: "huggingface",
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });

  const result = await generateText({
    model: huggingFace(config.model),
    system: ENHANCEMENT_SYSTEM_PROMPT,
    prompt: buildEnhancementPrompt(request),
    output: Output.object({
      schema: modelDecisionSchema,
      name: "health_scheduler_decision",
      description:
        "A non-diagnostic, allowlisted next action for a health scheduling conversation.",
    }),
    temperature: 0,
    maxOutputTokens: config.maxOutputTokens,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(config.timeoutMs),
  });

  return { decision: result.output, model: config.model };
}
