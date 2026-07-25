import {
  chatEnhancementResponseSchema,
  type ChatEnhancementRequest,
  type ChatEnhancementResponse,
} from "@/lib/llm/contracts";

export async function requestChatEnhancement(
  request: ChatEnhancementRequest,
  signal?: AbortSignal,
): Promise<ChatEnhancementResponse> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Chat enhancement failed with status ${response.status}.`);
  }

  const parsed = chatEnhancementResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Chat enhancement returned an invalid response.");
  }

  return parsed.data;
}
