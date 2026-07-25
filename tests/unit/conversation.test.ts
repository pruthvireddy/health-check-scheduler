import { describe, expect, it } from "vitest";
import { createSyntheticSpecialtyRouter } from "@/lib/adapters/deterministic";
import { createInitialConversationState, progressConversation } from "@/lib/core";

describe("deterministic conversation progression", () => {
  it("preserves the urgent exit before routing", async () => {
    const result = await progressConversation(createInitialConversationState("test"), { type: "submit_symptoms", text: "I have severe chest pain" }, createSyntheticSpecialtyRouter());
    expect(result.state.stage).toBe("urgent_exit");
    expect(result.action).toMatchObject({ type: "show_urgent_guidance" });
  });

  it("asks follow-ups then offers a recommendation", async () => {
    const router = createSyntheticSpecialtyRouter();
    const first = await progressConversation(createInitialConversationState("test"), { type: "submit_symptoms", text: "I have an itchy rash" }, router);
    expect(first.state.stage).toBe("asking_follow_ups");
    const questionId = first.action?.type === "ask_follow_up" ? first.action.questionId : "duration";
    const second = await progressConversation(first.state, { type: "answer_follow_up", questionId, text: "For two weeks" }, router);
    const nextQuestionId = second.action?.type === "ask_follow_up" ? second.action.questionId : "severity";
    const third = await progressConversation(second.state, { type: "answer_follow_up", questionId: nextQuestionId, text: "It has not changed" }, router);
    const finalQuestionId = third.action?.type === "ask_follow_up" ? third.action.questionId : "derm-change";
    const final = await progressConversation(third.state, { type: "answer_follow_up", questionId: finalQuestionId, text: "No other changes" }, router);
    expect(final.state.stage).toBe("recommending_specialist");
    expect(final.state.recommendation?.specialtyId).toBe("dermatology");
  });
});
