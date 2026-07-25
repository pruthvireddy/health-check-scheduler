import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

import type { ParsedChatEnhancementRequest } from "@/lib/llm/contracts";

import type { LlmEnhancementConfig } from "./config";
import {
  buildEnhancementPrompt,
  ENHANCEMENT_SYSTEM_PROMPT,
} from "./prompt";

export type HuggingFaceEnhancementResult = {
  text: string;
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
    temperature: 0,
    maxOutputTokens: config.maxOutputTokens,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(config.timeoutMs),
  });

  return { text: result.text, model: config.model };
}
