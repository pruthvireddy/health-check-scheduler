export const CHAT_MODES = ["local", "hybrid", "llm-required"] as const;

export type ChatMode = (typeof CHAT_MODES)[number];

export type LlmEnhancementConfig = {
  mode: ChatMode;
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
  confidenceThreshold: number;
};

const numberFromEnvironment = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(maximum, Math.max(minimum, parsed));
};

const chatModeFromEnvironment = (value: string | undefined): ChatMode => {
  return CHAT_MODES.includes(value as ChatMode) ? (value as ChatMode) : "hybrid";
};

/**
 * Read configuration per request so Vercel environment changes and tests do not
 * depend on module initialization order. Secrets are never returned by the API.
 */
export function getLlmEnhancementConfig(): LlmEnhancementConfig {
  const apiKey = process.env.HF_TOKEN?.trim();

  return {
    mode: chatModeFromEnvironment(process.env.CHAT_MODE?.trim()),
    apiKey: apiKey || undefined,
    baseUrl:
      process.env.HF_BASE_URL?.trim() || "https://router.huggingface.co/v1",
    model:
      process.env.HF_CHAT_MODEL?.trim() || "Qwen/Qwen2.5-7B-Instruct",
    timeoutMs: numberFromEnvironment(
      process.env.LLM_TIMEOUT_MS,
      12_000,
      1_000,
      25_000,
    ),
    maxOutputTokens: Math.round(
      numberFromEnvironment(
        process.env.LLM_MAX_OUTPUT_TOKENS,
        300,
        100,
        600,
      ),
    ),
    confidenceThreshold: numberFromEnvironment(
      process.env.LLM_CONFIDENCE_THRESHOLD,
      0.7,
      0.5,
      0.95,
    ),
  };
}
