import { MAX_FOLLOW_UP_QUESTIONS } from "@/config";
import { getCompatibleLocations, getFollowUpQuestion, getSupportedDurations, syntheticMappings } from "@/lib/adapters/deterministic";
import { normalizeSymptomEvidence } from "@/lib/adapters/deterministic";
import { recommendationFromRouting } from "@/lib/core/routing";
import { screenForUrgentRedFlags } from "@/lib/core/safety";
import type { ConversationProgress, ConversationState, SpecialtyRouter, SymptomEvidence } from "@/lib/core/types";

export type ConversationEvent =
  | { type: "submit_symptoms"; text: string }
  | { type: "answer_follow_up"; questionId: string; text: string }
  | { type: "accept_recommendation" }
  | { type: "select_location"; locationId: string }
  | { type: "select_duration"; durationMinutes: number }
  | { type: "select_date"; date: string }
  | { type: "select_time"; startsAt: string }
  | { type: "restart" };

export function createInitialConversationState(id = `conversation-${Date.now()}`): ConversationState {
  return { id, stage: "welcome", evidence: [], followUpQuestionIds: [], answeredFollowUpIds: [] };
}

const urgentProgress = (state: ConversationState, text: string): ConversationProgress | undefined => {
  const urgentResult = screenForUrgentRedFlags(text);
  if (!urgentResult.isUrgent) return undefined;
  return { state: { ...state, stage: "urgent_exit", urgentResult }, message: urgentResult.guidance!, action: { type: "show_urgent_guidance", category: urgentResult.category! } };
};

function questionIdsForEvidence(evidence: SymptomEvidence[]): string[] {
  const terms = new Set(evidence.map((item) => item.normalizedTerm));
  const specialtyQuestionIds = syntheticMappings
    .filter((mapping) => mapping.symptomTerms.some((term) => terms.has(term)))
    .flatMap((mapping) => mapping.followUpQuestionIds);
  return [...new Set(["duration", "severity", ...specialtyQuestionIds])].slice(0, MAX_FOLLOW_UP_QUESTIONS);
}

async function showRecommendation(state: ConversationState, router: SpecialtyRouter): Promise<ConversationProgress> {
  const recommendation = recommendationFromRouting(await router.route({ evidence: state.evidence }));
  return {
    state: { ...state, stage: "recommending_specialist", recommendation },
    message: `${recommendation.rationale} Would you like to see appointment options?`,
    action: { type: "show_recommendation", recommendation }
  };
}

/** Strict, deterministic state transitions for the local demo workflow. */
export async function progressConversation(state: ConversationState, event: ConversationEvent, router: SpecialtyRouter): Promise<ConversationProgress> {
  if (event.type === "restart") {
    return { state: createInitialConversationState(state.id), message: "Tell me the main symptom or concern you would like to schedule for." };
  }
  if (state.stage === "urgent_exit" || state.stage === "confirmed" || state.stage === "cancelled") {
    return { state, message: "Start a new conversation to begin another scheduling request." };
  }
  if (event.type === "submit_symptoms") {
    if (state.stage !== "welcome" && state.stage !== "collecting_symptoms") {
      return { state, message: "Use the current scheduling control to continue." };
    }
    const urgent = urgentProgress(state, event.text);
    if (urgent) return urgent;
    const evidence = normalizeSymptomEvidence(event.text);
    const questionIds = questionIdsForEvidence(evidence);
    const next = { ...state, stage: "asking_follow_ups" as const, evidence, followUpQuestionIds: questionIds, answeredFollowUpIds: [] };
    const question = questionIds.map(getFollowUpQuestion).find(Boolean);
    if (!question) return showRecommendation(next, router);
    return { state: next, message: question.prompt, action: { type: "ask_follow_up", questionId: question.id } };
  }
  if (event.type === "answer_follow_up" && state.stage === "asking_follow_ups") {
    const urgent = urgentProgress(state, event.text);
    if (urgent) return urgent;
    const answerEvidence = normalizeSymptomEvidence(event.text, `follow-up-${state.answeredFollowUpIds.length + 1}`);
    const answeredFollowUpIds = [...new Set([...state.answeredFollowUpIds, event.questionId])];
    const next = { ...state, evidence: [...state.evidence, ...answerEvidence], answeredFollowUpIds };
    const nextQuestionId = state.followUpQuestionIds.find((id) => !answeredFollowUpIds.includes(id));
    const nextQuestion = nextQuestionId ? getFollowUpQuestion(nextQuestionId) : undefined;
    if (nextQuestion) return { state: next, message: nextQuestion.prompt, action: { type: "ask_follow_up", questionId: nextQuestion.id } };
    return showRecommendation(next, router);
  }
  if (event.type === "accept_recommendation" && state.stage === "recommending_specialist" && state.recommendation) {
    return { state: { ...state, stage: "selecting_location" }, message: "Choose a location for your demo appointment.", action: { type: "start_scheduling", specialtyId: state.recommendation.specialtyId } };
  }
  if (event.type === "select_location" && state.stage === "selecting_location") {
    if (!state.recommendation || !getCompatibleLocations(state.recommendation.specialtyId).some((location) => location.id === event.locationId)) {
      return { state, message: "Please choose one of the locations offered for this scheduling suggestion." };
    }
    return { state: { ...state, stage: "selecting_duration", selectedLocationId: event.locationId, selectedDurationMinutes: undefined, selectedDate: undefined, selectedSlotStart: undefined }, message: "Choose an appointment length." };
  }
  if (event.type === "select_duration" && state.stage === "selecting_duration") {
    if (!state.recommendation || !state.selectedLocationId || !getSupportedDurations(state.recommendation.specialtyId, state.selectedLocationId).includes(event.durationMinutes)) {
      return { state, message: "Please choose an offered appointment length." };
    }
    return { state: { ...state, stage: "selecting_date", selectedDurationMinutes: event.durationMinutes, selectedDate: undefined, selectedSlotStart: undefined }, message: "Choose a date with available times." };
  }
  if (event.type === "select_date" && state.stage === "selecting_date") {
    return { state: { ...state, stage: "selecting_time", selectedDate: event.date, selectedSlotStart: undefined }, message: "Choose an available time." };
  }
  if (event.type === "select_time" && state.stage === "selecting_time") {
    return { state: { ...state, stage: "reviewing_appointment", selectedSlotStart: event.startsAt }, message: "Review your demo appointment before confirming." };
  }
  return { state, message: "That selection is not available at this point in the scheduling flow." };
}
