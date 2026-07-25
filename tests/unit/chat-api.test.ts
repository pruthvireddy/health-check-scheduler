import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/chat/route";
import { chatEnhancementResponseSchema } from "@/lib/llm";

const validRequestBody = (text = "I have had an itchy rash for three days") => ({
  conversationId: "conversation-1",
  stage: "collecting_symptoms",
  recentMessages: [{ role: "user", content: text }],
  approvedEvidence: [],
  answeredQuestionTypes: [],
  followUpCount: 0,
});

const requestFor = (body: unknown) =>
  new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chat enhancement API fallback behavior", () => {
  it("rejects an invalid request before reading model configuration", async () => {
    vi.stubEnv("CHAT_MODE", "llm-required");
    vi.stubEnv("HF_TOKEN", "");

    const response = await POST(requestFor({ conversationId: "missing-fields" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: {
        code: "invalid_request",
      },
    });
  });

  it("returns the complete synthetic path in local mode", async () => {
    vi.stubEnv("CHAT_MODE", "local");
    vi.stubEnv("HF_TOKEN", "");

    const response = await POST(requestFor(validRequestBody()));
    const body = chatEnhancementResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      mode: "synthetic_fallback",
      fallbackReason: "local_mode",
    });
  });

  it("falls back without a provider call when hybrid mode has no token", async () => {
    vi.stubEnv("CHAT_MODE", "hybrid");
    vi.stubEnv("HF_TOKEN", "");

    const response = await POST(requestFor(validRequestBody()));
    const body = chatEnhancementResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      mode: "synthetic_fallback",
      fallbackReason: "missing_hf_token",
    });
  });

  it("runs deterministic urgent screening before required-model checks", async () => {
    vi.stubEnv("CHAT_MODE", "llm-required");
    vi.stubEnv("HF_TOKEN", "");

    const response = await POST(
      requestFor(validRequestBody("I have crushing chest pain right now")),
    );
    const body = chatEnhancementResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      nextAction: "urgent_review",
      confidence: 1,
    });
    expect(body.fallbackReason).toMatch(/^urgent_screening:/);
  });
});
