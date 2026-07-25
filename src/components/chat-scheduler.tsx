"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  createAppointment,
  getAvailableSlots,
  recommendationFromRouting,
  screenForUrgentRedFlags,
  type Appointment,
  type AvailableSlot,
  type ClinicLocation,
  type ConversationStage,
  type Recommendation,
  type SpecialtyId,
  type RoutingCandidate,
  type RoutingResult,
  type SymptomEvidence,
} from "@/lib/core";
import {
  createHybridSpecialtyRouter,
  getCompatibleLocations,
  getDefaultSpecialistForSpecialty,
  getSupportedDurations,
  normalizeSymptomEvidence,
} from "@/lib/adapters/deterministic";
import {
  approveContextReview,
  extractContextFile,
  type ContextExtractionSuccess,
} from "@/lib/context";
import {
  followUpPromptFor,
  type ChatEnhancementResponse,
  type FollowUpQuestionType,
  type RetrievedSpecialtyCandidate,
} from "@/lib/llm/contracts";
import { requestChatEnhancement } from "@/lib/llm/client";
import { browserPersistence } from "@/lib/persistence";
import type { ContextReview } from "@/lib/validation";

type Stage =
  | "intake"
  | "followup-one"
  | "followup-two"
  | "recommendation"
  | "location"
  | "duration"
  | "date"
  | "time"
  | "review"
  | "confirmed"
  | "urgent";

type Message = {
  id: string;
  role: "assistant" | "user";
  text: string;
  createdAt: string;
};

type ReviewedContext = {
  name: string;
  size: number;
  review: ContextReview;
  warnings: string[];
};

type DateChoice = {
  key: string;
  weekday: string;
  day: string;
};

type EnhancementStatus = "local" | "checking" | "llm" | "error";
type EnhancementAttempt =
  | ChatEnhancementResponse
  | { requiredError: true }
  | null;

const RETRIEVED_CARD_LIMIT = 4;
const SPECIALTY_CARD_LIMIT = 4;

type SpecialtyRecommendationCard = RoutingCandidate & {
  rationale: string;
};

const MODEL_CONFIDENCE_THRESHOLD = 0.7;
const FALLBACK_QUESTION_ORDER: FollowUpQuestionType[] = [
  "onset",
  "associated_symptoms",
  "severity",
  "progression",
  "duration",
  "injury_context",
  "recurrence",
  "current_status",
];

const SPECIALTY_LABELS: Record<SpecialtyId, string> = {
  "primary-care": "Primary care",
  cardiology: "Cardiology",
  dermatology: "Dermatology",
  gastroenterology: "Gastroenterology",
  neurology: "Headache neurology",
  orthopedics: "Orthopedics & sports medicine",
  ent: "Ear, nose & throat",
};

const STAGE_MAP: Record<Stage, ConversationStage> = {
  intake: "collecting_symptoms",
  "followup-one": "asking_follow_ups",
  "followup-two": "asking_follow_ups",
  recommendation: "recommending_specialist",
  location: "selecting_location",
  duration: "selecting_duration",
  date: "selecting_date",
  time: "selecting_time",
  review: "reviewing_appointment",
  confirmed: "confirmed",
  urgent: "urgent_exit",
};

const initialAssistantMessage = (text: string): Message => ({
  id: `message-${Date.now()}-${Math.random()}`,
  role: "assistant",
  text,
  createdAt: new Date().toISOString(),
});

function dateKeyForSlot(startsAt: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(startsAt));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function dateChoiceFromSlot(slot: AvailableSlot): DateChoice {
  const value = new Date(slot.startsAt);
  return {
    key: dateKeyForSlot(slot.startsAt, slot.timezone),
    weekday: new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      timeZone: slot.timezone,
    }).format(value),
    day: new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      timeZone: slot.timezone,
    }).format(value),
  };
}

function formatTime(slot: AvailableSlot): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: slot.timezone,
  }).format(new Date(slot.startsAt));
}

function approvedContextEvidence(context: ReviewedContext | null): SymptomEvidence[] {
  if (!context?.review.approved) return [];
  return context.review.evidence
    .filter((item) => !item.negated && item.userApproved)
    .map(({ negated: _negated, ...item }) => item);
}

function mergeEvidence(...groups: SymptomEvidence[][]): SymptomEvidence[] {
  const unique = new Map<string, SymptomEvidence>();
  groups.flat().forEach((item) => {
    const key = `${item.source}:${item.normalizedTerm}:${item.temporality}`;
    if (!unique.has(key)) unique.set(key, item);
  });
  return [...unique.values()];
}

function scoreConfidenceLabel(confidence: number): string {
  if (confidence >= 0.8) return "Very likely match";
  if (confidence >= 0.65) return "Likely match";
  return "Possible match";
}

function formatMatchedTerms(terms: string[] | undefined): string {
  if (!terms?.length) return "symptom pattern review";
  return terms.slice(0, 3).join(", ");
}

function buildSpecialtyCards(candidates: RoutingCandidate[]): SpecialtyRecommendationCard[] {
  return candidates
    .slice(0, SPECIALTY_CARD_LIMIT)
    .map((candidate) => ({
      ...candidate,
      rationale: `${scoreConfidenceLabel(candidate.confidence)} · Matched: ${formatMatchedTerms(candidate.matchedTerms)}`,
    }));
}

function chooseUnansweredQuestion(
  answered: FollowUpQuestionType[],
  preferred: FollowUpQuestionType,
): FollowUpQuestionType {
  return (
    [preferred, ...FALLBACK_QUESTION_ORDER].find(
      (questionType) => !answered.includes(questionType),
    ) ?? "current_status"
  );
}

export function ChatScheduler({
  chatMode = "hybrid",
}: {
  chatMode?: "local" | "hybrid" | "llm-required";
}) {
  const [conversationId, setConversationId] = useState(() => `conversation-${Date.now()}`);
  const [stage, setStage] = useState<Stage>("intake");
  const [messages, setMessages] = useState<Message[]>([
    initialAssistantMessage(
      "Hi, I’m your scheduling guide. Tell me what’s bothering you, where it’s happening, and roughly how long it has been going on.",
    ),
  ]);
  const [draft, setDraft] = useState("");
  const [conversationText, setConversationText] = useState("");
  const [evidence, setEvidence] = useState<SymptomEvidence[]>([]);
  const [contextFile, setContextFile] = useState<ReviewedContext | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [specialtyCards, setSpecialtyCards] = useState<SpecialtyRecommendationCard[]>([]);
  const [activeRoutingResult, setActiveRoutingResult] =
    useState<RoutingResult | null>(null);
  const [location, setLocation] = useState<ClinicLocation | null>(null);
  const [durationMinutes, setDurationMinutes] = useState<number | null>(null);
  const [date, setDate] = useState<DateChoice | null>(null);
  const [slot, setSlot] = useState<AvailableSlot | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [confirmedAppointment, setConfirmedAppointment] = useState<Appointment | null>(null);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [confirmationError, setConfirmationError] = useState("");
  const [enhancementStatus, setEnhancementStatus] =
    useState<EnhancementStatus>("local");
  const [answeredQuestionTypes, setAnsweredQuestionTypes] = useState<
    FollowUpQuestionType[]
  >([]);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const enhancementAbortRef = useRef<AbortController | null>(null);
  const enhancementGenerationRef = useRef(0);

  const specialtyId = recommendation?.specialtyId ?? "primary-care";
  const specialtyLabel = SPECIALTY_LABELS[specialtyId];
  const compatibleLocations = useMemo(
    () => getCompatibleLocations(specialtyId),
    [specialtyId],
  );
  const compatibleDurations = useMemo(
    () =>
      location
        ? getSupportedDurations(specialtyId, location.id)
        : [],
    [location, specialtyId],
  );
  const specialist = useMemo(
    () =>
      location
        ? getDefaultSpecialistForSpecialty(specialtyId, location.id)
        : undefined,
    [location, specialtyId],
  );
  const availableSlots = useMemo(
    () =>
      specialist && location && durationMinutes
        ? getAvailableSlots({
            specialistId: specialist.id,
            locationId: location.id,
            durationMinutes,
            appointments,
          })
        : [],
    [appointments, durationMinutes, location, specialist],
  );
  const dates = useMemo(() => {
    const unique = new Map<string, DateChoice>();
    availableSlots.forEach((availableSlot) => {
      const choice = dateChoiceFromSlot(availableSlot);
      if (!unique.has(choice.key)) unique.set(choice.key, choice);
    });
    return [...unique.values()].slice(0, 3);
  }, [availableSlots]);
  const times = useMemo(
    () =>
      date
        ? availableSlots
            .filter(
              (availableSlot) =>
                dateKeyForSlot(availableSlot.startsAt, availableSlot.timezone) ===
                date.key,
            )
            .slice(0, 6)
        : [],
    [availableSlots, date],
  );

  useEffect(() => {
    setAppointments(browserPersistence.loadAppointments());
    return () => enhancementAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo?.({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [stage, messages, contextFile]);

  useEffect(() => {
    const now = new Date().toISOString();
    try {
      browserPersistence.saveConversation({
        id: conversationId,
        stage: STAGE_MAP[stage],
        messages,
        evidence,
        contextReviews: contextFile ? [contextFile.review] : [],
        followUpQuestionIds: ["duration", "severity"],
        answeredFollowUpIds:
          stage === "intake"
            ? []
            : stage === "followup-one"
              ? ["duration"]
              : ["duration", "severity"],
        recommendation: recommendation ?? undefined,
        selectedLocationId: location?.id,
        selectedDurationMinutes: durationMinutes ?? undefined,
        selectedDate: date?.key,
        selectedSlotStart: slot?.startsAt,
        createdAt: messages[0]?.createdAt ?? now,
        updatedAt: now,
      });
    } catch {
      // The persistence adapter automatically falls back to memory when needed.
    }
  }, [
    contextFile,
    conversationId,
    date,
    durationMinutes,
    evidence,
    location,
    messages,
    recommendation,
    slot,
    stage,
  ]);

  const addMessage = (role: Message["role"], text: string) =>
    setMessages((current) => [
      ...current,
      {
        id: `message-${Date.now()}-${Math.random()}`,
        role,
        text,
        createdAt: new Date().toISOString(),
      },
    ]);

  const continueWith = (nextStage: Stage, assistantText: string) => {
    setStage(nextStage);
    addMessage("assistant", assistantText);
    setAnnouncement(assistantText);
  };

  function getEvidenceForModel(): SymptomEvidence[] {
    return mergeEvidence(evidence, approvedContextEvidence(contextFile)).filter(
      (item) => item.userApproved,
    );
  }

  function candidatePayload(candidates: RoutingCandidate[]): RetrievedSpecialtyCandidate[] {
    return candidates
      .slice(0, RETRIEVED_CARD_LIMIT)
      .map((candidate) => ({
        specialtyId: candidate.specialtyId,
        confidence: candidate.confidence,
        matchedTerms: candidate.matchedTerms,
      } satisfies RetrievedSpecialtyCandidate));
  }

  function fallbackRoutingCandidates(): RoutingCandidate[] {
    if (activeRoutingResult?.candidates?.length) {
      return activeRoutingResult.candidates;
    }

    return [
      {
        specialtyId,
        confidence: 0.5,
        evidenceIds: evidence.map((evidenceItem) => evidenceItem.id),
        matchedTerms: evidenceTerms,
      },
    ];
  }

  async function requestPhaseLead(
    nextStage: Stage,
    triggerText: string,
    candidates: RoutingCandidate[],
    fallbackText: string,
  ): Promise<string> {
    if (chatMode === "local") {
      return fallbackText;
    }

    enhancementAbortRef.current?.abort();
    const controller = new AbortController();
    enhancementAbortRef.current = controller;
    setEnhancementStatus("checking");
    setAnnouncement("Crafting next conversational step.");

    try {
      const response = await requestChatEnhancement(
        {
          conversationId,
          stage: STAGE_MAP[nextStage],
          recentMessages: [
            ...messages.map((message) => ({
              role: message.role,
              content: message.text,
            })),
            { role: "user" as const, content: triggerText },
          ].slice(-8),
          approvedEvidence: getEvidenceForModel(),
          retrievedCandidates: candidatePayload(candidates),
          answeredQuestionTypes,
          followUpCount: 4,
        },
        controller.signal,
      );

      if (controller.signal.aborted) return fallbackText;
      if (response.mode !== "llm" || !response.conversationalLead) {
        setEnhancementStatus(response.mode === "llm" ? "llm" : "local");
        return fallbackText;
      }

      setEnhancementStatus("llm");
      return response.conversationalLead;
    } catch {
      if (!controller.signal.aborted && chatMode === "llm-required") {
        setEnhancementStatus("error");
      } else if (!controller.signal.aborted) {
        setEnhancementStatus("local");
      }
      return fallbackText;
    } finally {
      if (enhancementAbortRef.current === controller) {
        enhancementAbortRef.current = null;
      }
    }
  }

  async function transitionWithLlmLead(
    nextStage: Stage,
    fallbackText: string,
    triggerText: string,
    candidates: RoutingCandidate[],
  ) {
    const assistantText = await requestPhaseLead(
      nextStage,
      triggerText,
      candidates,
      fallbackText,
    );
    continueWith(nextStage, assistantText);
  }

  async function tryEnhancement(
    currentText: string,
    currentStage: "intake" | "followup-one" | "followup-two",
    evidenceForRouting: SymptomEvidence[],
    routerCandidates: RoutingCandidate[],
  ): Promise<EnhancementAttempt> {
    if (chatMode === "local") {
      setEnhancementStatus("local");
      return null;
    }

    enhancementAbortRef.current?.abort();
    const controller = new AbortController();
    enhancementAbortRef.current = controller;
    setEnhancementStatus("checking");
    setAnnouncement("Checking for a more relevant follow-up.");

    try {
      const approvedEvidence = mergeEvidence(
        evidenceForRouting,
        approvedContextEvidence(contextFile),
      ).filter((item) => item.userApproved);
      const retrievedCandidates = routerCandidates
        .slice(0, RETRIEVED_CARD_LIMIT)
        .map((candidate) => ({
          specialtyId: candidate.specialtyId,
          confidence: candidate.confidence,
          matchedTerms: candidate.matchedTerms,
        } satisfies RetrievedSpecialtyCandidate));
      const response = await requestChatEnhancement(
        {
          conversationId,
          stage: STAGE_MAP[currentStage],
          recentMessages: [
            ...messages.map((message) => ({
              role: message.role,
              content: message.text,
            })),
            { role: "user" as const, content: currentText },
          ].slice(-8),
          approvedEvidence,
          retrievedCandidates,
          answeredQuestionTypes,
          followUpCount:
            currentStage === "intake"
              ? 0
              : currentStage === "followup-one"
                ? 1
                : 2,
        },
        controller.signal,
      );

      if (controller.signal.aborted) return null;
      if (response.nextAction === "urgent_review") {
        setEnhancementStatus(response.mode === "llm" ? "llm" : "local");
        return response;
      }
      if (response.mode !== "llm") {
        setEnhancementStatus("local");
        return null;
      }

      setEnhancementStatus("llm");
      return response;
    } catch {
      if (!controller.signal.aborted && chatMode === "llm-required") {
        setEnhancementStatus("error");
        return { requiredError: true };
      }
      if (!controller.signal.aborted) setEnhancementStatus("local");
      return null;
    } finally {
      if (enhancementAbortRef.current === controller) {
        enhancementAbortRef.current = null;
      }
    }
  }

  const fallbackRoutingResult: RoutingResult = {
    backend: "synthetic",
    version: "2026.07-demo",
    candidates: [
      {
        specialtyId: "primary-care",
        confidence: 0.5,
        evidenceIds: [],
        matchedTerms: [],
      },
    ],
    provenanceIds: ["fallback-routing"],
  };

  function recommendationForSpecialty(
    candidate: RoutingCandidate,
    routingResult: RoutingResult,
  ): Recommendation {
    return recommendationFromRouting({
      ...routingResult,
      candidates: [candidate],
    });
  }

  async function routeFromEvidence(allEvidence: SymptomEvidence[]): Promise<RoutingResult> {
    try {
      const routing = await createHybridSpecialtyRouter().route({
        evidence: allEvidence,
      });
      return routing;
    } catch {
      return fallbackRoutingResult;
    }
  }

  async function submitMessage(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (
      !text ||
      enhancementStatus === "checking" ||
      (stage !== "intake" &&
        stage !== "followup-one" &&
        stage !== "followup-two")
    )
      return;

    const combinedText = `${conversationText} ${text}`.trim();
    setConversationText(combinedText);
    setDraft("");
    addMessage("user", text);

    if (screenForUrgentRedFlags(text).isUrgent) {
      setStage("urgent");
      setAnnouncement("Urgent symptoms identified. Routine scheduling stopped.");
      return;
    }

    const intakeStage = stage;
    const routingEvidence = [
      ...normalizeSymptomEvidence(combinedText, `${conversationId}-symptom`),
      ...approvedContextEvidence(contextFile),
    ];
    const allEvidence = mergeEvidence(evidence, routingEvidence).filter(
      (item) => item.userApproved,
    );
    setEvidence(allEvidence);

    const routingResult = await routeFromEvidence(allEvidence);
    const routingCandidates = routingResult.candidates.length
      ? routingResult.candidates
      : fallbackRoutingResult.candidates;

    setSpecialtyCards(buildSpecialtyCards(routingCandidates));
    setActiveRoutingResult(routingResult);

    const enhancementGeneration = ++enhancementGenerationRef.current;
    const enhancement = await tryEnhancement(
      text,
      intakeStage,
      allEvidence,
      routingCandidates,
    );
    if (enhancementGeneration !== enhancementGenerationRef.current) return;
    if (enhancement && "requiredError" in enhancement) {
      addMessage(
        "assistant",
        "AI enhancement is unavailable in required mode. Check the server configuration and try again.",
      );
      setAnnouncement(
        "AI enhancement is unavailable in required mode. Check the server configuration.",
      );
      return;
    }
    if (enhancement?.nextAction === "urgent_review") {
      setStage("urgent");
      setAnnouncement("Urgent symptoms identified. Routine scheduling stopped.");
      return;
    }

    if (stage === "intake") {
      const questionType =
        enhancement?.nextAction === "ask_follow_up" &&
        enhancement.questionType &&
        !answeredQuestionTypes.includes(enhancement.questionType)
          ? enhancement.questionType
          : chooseUnansweredQuestion(answeredQuestionTypes, "onset");
      setAnsweredQuestionTypes((current) => [...current, questionType]);
      const lead = enhancement?.conversationalLead ?? "Thanks.";
      continueWith(
        "followup-one",
        `${lead} ${followUpPromptFor(questionType)}`,
      );
      return;
    }
    if (stage === "followup-one") {
      const questionType =
        enhancement?.nextAction === "ask_follow_up" &&
        enhancement.questionType &&
        !answeredQuestionTypes.includes(enhancement.questionType)
          ? enhancement.questionType
          : chooseUnansweredQuestion(
              answeredQuestionTypes,
              "associated_symptoms",
            );
      setAnsweredQuestionTypes((current) => [...current, questionType]);
      const lead =
        enhancement?.conversationalLead ?? "Thanks for clarifying.";
      continueWith(
        "followup-two",
        `${lead} ${followUpPromptFor(questionType)}`,
      );
      return;
    }

    const llmSuggested =
      enhancement?.nextAction === "recommend_specialist" &&
      enhancement.specialtyId &&
      enhancement.confidence >= MODEL_CONFIDENCE_THRESHOLD;

    const recommendedSpecialty = llmSuggested
      ? routingCandidates.find((item) => item.specialtyId === enhancement.specialtyId)
      : undefined;

    const preferredCandidate: RoutingCandidate =
      recommendedSpecialty ??
      routingCandidates[0] ?? {
        specialtyId: enhancement?.specialtyId ?? routingCandidates[0]?.specialtyId ?? "primary-care",
        confidence: Math.max(0.5, enhancement?.confidence ?? 0.5),
        evidenceIds: allEvidence.map((item) => item.id),
        matchedTerms: [],
      };

    const orderedCards = llmSuggested
      ? buildSpecialtyCards(
          [
            preferredCandidate,
            ...routingCandidates.filter(
              (candidate) => candidate.specialtyId !== preferredCandidate.specialtyId,
            ),
          ],
        )
      : buildSpecialtyCards(routingCandidates);
    setSpecialtyCards(orderedCards);
    setRecommendation(
      recommendationForSpecialty(preferredCandidate, {
        ...routingResult,
        candidates: [preferredCandidate],
      }),
    );

    const lead =
      enhancement?.conversationalLead ?? "I have enough to suggest a next step.";
    continueWith(
      "recommendation",
      `${lead} Choose one specialty to continue scheduling.`,
    );
  }

  async function handleAttachment(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setAnnouncement("Reading the context file locally.");
    const result = await extractContextFile(file);
    if (result.status !== "accepted") {
      setContextFile(null);
      setAnnouncement(result.message);
      return;
    }
    const accepted: ContextExtractionSuccess = result;
    setContextFile({
      name: file.name,
      size: file.size,
      review: accepted.review,
      warnings: accepted.warnings,
    });
    setAnnouncement("Context file extracted locally and ready for your review.");
  }

  function approveContext() {
    if (!contextFile) return;
    const approved = approveContextReview(contextFile.review);
    setContextFile({ ...contextFile, review: approved });
    setAnnouncement("Context approved for this conversation.");
  }

  function removeContext() {
    setContextFile(null);
    setAnnouncement("Context removed.");
  }

  async function selectLocation(item: ClinicLocation) {
    setLocation(item);
    setDurationMinutes(null);
    setDate(null);
    setSlot(null);

    await transitionWithLlmLead(
      "duration",
      `${item.name} selected. Choose appointment duration next.`,
      `User selected ${item.name} for ${specialtyLabel} scheduling.`,
      fallbackRoutingCandidates(),
    );
  }

  async function selectDuration(item: number) {
    setDurationMinutes(item);
    setDate(null);
    setSlot(null);

    await transitionWithLlmLead(
      "date",
      `Duration set to ${item} minutes. Choose a date next.`,
      `The patient selected a ${item}-minute appointment.`,
      fallbackRoutingCandidates(),
    );
  }

  async function selectDate(item: DateChoice) {
    setDate(item);
    setSlot(null);
    await transitionWithLlmLead(
      "time",
      `${item.weekday}, ${item.day} selected. Choose an available time.`,
      `The user selected ${item.weekday}, ${item.day} for the visit.`,
      fallbackRoutingCandidates(),
    );
  }

  async function selectTime(item: AvailableSlot) {
    setSlot(item);

    await transitionWithLlmLead(
      "review",
      "Time selected. Review your appointment before confirming.",
      `The patient selected a ${item.startsAt} appointment time.`,
      fallbackRoutingCandidates(),
    );
  }

  async function pickSpecialtyCard(card: SpecialtyRecommendationCard) {
    if (!activeRoutingResult) return;
    setRecommendation(recommendationForSpecialty(card, {
      ...activeRoutingResult,
      candidates: [card],
    }));
    setSpecialtyCards([card]);

    await transitionWithLlmLead(
      "location",
      `${SPECIALTY_LABELS[card.specialtyId]} selected. Choose a location next.`,
      `User selected ${SPECIALTY_LABELS[card.specialtyId]} as the best option.`,
      activeRoutingResult?.candidates ?? [card],
    );
  }

  function confirm() {
    setConfirmationError("");
    if (!displayName.trim() || !location || !durationMinutes || !slot || !specialist) {
      setConfirmationError("Complete the appointment details before confirming.");
      return;
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setConfirmationError("Enter a valid email address or leave the optional field blank.");
      return;
    }
    try {
      const appointment = createAppointment(
        {
          conversationId,
          patientDisplayName: displayName.trim(),
          contactEmail: email.trim() || undefined,
          specialistId: specialist.id,
          locationId: location.id,
          durationMinutes,
          startsAt: slot.startsAt,
          timezone: slot.timezone,
        },
        appointments,
      );
      browserPersistence.saveAppointment(appointment);
      setAppointments((current) => [appointment, ...current]);
      setConfirmedAppointment(appointment);
      setStage("confirmed");
      setAnnouncement(
        `Appointment confirmed. Your code is ${appointment.confirmationCode}.`,
      );
    } catch (error) {
      setConfirmationError(
        error instanceof Error
          ? error.message
          : "The appointment could not be confirmed.",
      );
    }
  }

  function newConversation() {
    enhancementGenerationRef.current += 1;
    enhancementAbortRef.current?.abort();
    enhancementAbortRef.current = null;
    setConversationId(`conversation-${Date.now()}`);
    setStage("intake");
    setMessages([
      initialAssistantMessage(
        "Welcome back. What would you like help scheduling today?",
      ),
    ]);
    setDraft("");
    setConversationText("");
    setEvidence([]);
    setContextFile(null);
    setRecommendation(null);
    setSpecialtyCards([]);
    setActiveRoutingResult(null);
    setLocation(null);
    setDurationMinutes(null);
    setDate(null);
    setSlot(null);
    setDisplayName("");
    setEmail("");
    setConfirmedAppointment(null);
    setConfirmationError("");
    setEnhancementStatus("local");
    setAnsweredQuestionTypes([]);
    setAnnouncement("New conversation started.");
  }

  function clearData() {
    browserPersistence.clearAll();
    setAppointments([]);
    newConversation();
    setAnnouncement("Local demo data cleared and a new conversation started.");
  }

  const composerEnabled =
    enhancementStatus !== "checking" &&
    ["intake", "followup-one", "followup-two"].includes(stage);
  const modeCopy =
    enhancementStatus === "checking"
      ? {
          badge: "Checking assistant",
          detail: "Local safety rules stay active",
        }
      : enhancementStatus === "error"
        ? {
            badge: "AI unavailable",
            detail: "Required-mode configuration needs attention",
          }
        : enhancementStatus === "llm"
          ? {
              badge: "AI-assisted mode",
              detail: "Local safety and fallback enabled",
            }
          : {
              badge: "Local rules mode",
              detail: "No model or CSV required",
            };
  const formattedDate = slot
    ? new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: slot.timezone,
      }).format(new Date(slot.startsAt))
    : "";
  const formattedTime = slot ? formatTime(slot) : "";
  const evidenceTerms =
    contextFile?.review.evidence
      .filter((item) => !item.negated)
      .map((item) => item.normalizedTerm) ?? [];

  return (
    <main className="app-shell">
      <section className="app-frame" aria-label="Health Check Scheduler">
        <header className="app-header">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <div>
              <div className="brand-name">Health Check Scheduler</div>
              <div className="brand-subtitle">Find the right kind of care</div>
            </div>
          </div>
          <div className="header-actions">
            <button className="text-button" onClick={newConversation}>
              New conversation
            </button>
            <button className="text-button clear-label" onClick={clearData}>
              Clear local data
            </button>
          </div>
        </header>

        <div className="chat-panel">
          <div className="transcript" ref={transcriptRef}>
            <div className="chat-column">
              <div className="mode-row">
                <span className="mode-badge">{modeCopy.badge}</span>
                <span>{modeCopy.detail}</span>
              </div>

              {messages.map((message) => (
                <div className={`message-row ${message.role}`} key={message.id}>
                  {message.role === "assistant" && (
                    <span className="avatar" aria-hidden="true">
                      +
                    </span>
                  )}
                  <div className="bubble">
                    <p>{message.text}</p>
                  </div>
                </div>
              ))}

              {stage === "intake" && (
                <div className="disclaimer">
                  This is a scheduling guide, not medical advice or emergency care.
                  If you think you may be experiencing an emergency, call local
                  emergency services now.
                </div>
              )}

              {contextFile && stage !== "urgent" && (
                <section
                  className="inline-card context-card"
                  aria-label="Review attached context"
                >
                  <span className="card-eyebrow">Optional history</span>
                  <h3>Review your extracted context</h3>
                  <p>
                    {evidenceTerms.length
                      ? `Found: ${evidenceTerms.join(", ")}.`
                      : contextFile.warnings[0] ??
                        "No supported symptom terms were found."}{" "}
                    Only approved terms are used for routing.
                  </p>
                  <div className="context-file">
                    <span className="file-icon" aria-hidden="true">
                      ⌁
                    </span>
                    <div className="file-info">
                      <strong>{contextFile.name}</strong>
                      <small>
                        {Math.max(1, Math.round(contextFile.size / 1024))} KB ·
                        parsed locally
                      </small>
                    </div>
                  </div>
                  <div className="inline-actions">
                    {!contextFile.review.approved ? (
                      <button className="primary-button" onClick={approveContext}>
                        Use this context
                      </button>
                    ) : (
                      <span className="tag">Approved for this conversation</span>
                    )}
                    <button className="secondary-button" onClick={removeContext}>
                      Remove
                    </button>
                  </div>
                </section>
              )}

              {stage === "recommendation" && recommendation && (
                <section
                  className="inline-card recommendation"
                  aria-label="Specialist recommendation"
                >
                  <div className="recommendation-title">
                    <div>
                      <span className="card-eyebrow">Choose a specialist pathway</span>
                      <h2>{recommendation.rationale}</h2>
                    </div>
                    <span className="tag">
                      {recommendation.confidence === "high"
                        ? "High match"
                        : recommendation.confidence === "medium"
                          ? "Possible match"
                          : "Careful fallback"}
                    </span>
                  </div>
                  <p>
                    Pick one option and then continue to schedule your demo
                    appointment.
                  </p>
                  <div className="choice-grid three">
                    {specialtyCards.length ? (
                      specialtyCards.map((card) => (
                        <button
                          key={`${card.specialtyId}-${card.confidence}-${card.matchedTerms.join(",")}`}
                          className="choice"
                          onClick={() => pickSpecialtyCard(card)}
                        >
                          <span className="tag">{scoreConfidenceLabel(card.confidence)}</span>
                          <strong>{SPECIALTY_LABELS[card.specialtyId]}</strong>
                          <small>{card.rationale}</small>
                        </button>
                      ))
                    ) : (
                      <p>No specialty match is available yet.</p>
                    )}
                  </div>
                  {specialtyCards[0] ? (
                    <button
                      className="primary-button"
                      onClick={() => pickSpecialtyCard(specialtyCards[0])}
                    >
                      Find an appointment
                    </button>
                  ) : null}
                </section>
              )}

              {stage === "location" && (
                <section className="inline-card" aria-label="Select location">
                  <span className="question-label">Step 1 of 4 · Location</span>
                  <h2>Where works best?</h2>
                  <p>
                    These fictional clinics support {specialtyLabel} visits in
                    the demo catalog.
                  </p>
                  <div className="choice-grid">
                    {compatibleLocations.map((item) => (
                      <button
                        className="choice"
                        key={item.id}
                        onClick={() => selectLocation(item)}
                      >
                        {item.name}
                        <small>{item.address}</small>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {stage === "duration" && (
                <section className="inline-card" aria-label="Select duration">
                  <span className="question-label">
                    Step 2 of 4 · Visit length
                  </span>
                  <h2>How much time do you need?</h2>
                  <div className="choice-grid">
                    {compatibleDurations.map((item) => (
                      <button
                        className="choice"
                        key={item}
                        onClick={() => selectDuration(item)}
                      >
                        {item} minutes
                        <small>
                          {item <= 20 ? "Focused visit" : "More time to discuss"}
                        </small>
                      </button>
                    ))}
                  </div>
                  <div className="inline-actions">
                    <button
                      className="secondary-button"
                      onClick={() => setStage("location")}
                    >
                      Change location
                    </button>
                  </div>
                </section>
              )}

              {stage === "date" && (
                <section className="inline-card" aria-label="Select date">
                  <span className="question-label">Step 3 of 4 · Date</span>
                  <h2>Choose a day</h2>
                  <p>Times are displayed in the selected clinic’s timezone.</p>
                  <div className="choice-grid three">
                    {dates.map((item) => (
                      <button
                        className="choice"
                        key={item.key}
                        onClick={() => selectDate(item)}
                      >
                        {item.weekday}
                        <small>{item.day}</small>
                      </button>
                    ))}
                  </div>
                  {!dates.length && (
                    <p>No demo availability was found for this selection.</p>
                  )}
                  <div className="inline-actions">
                    <button
                      className="secondary-button"
                      onClick={() => setStage("duration")}
                    >
                      Change duration
                    </button>
                  </div>
                </section>
              )}

              {stage === "time" && (
                <section className="inline-card" aria-label="Select time">
                  <span className="question-label">
                    Step 4 of 4 · Available times
                  </span>
                  <h2>Pick a time</h2>
                  <p>
                    {date?.weekday}, {date?.day} at {location?.name}
                  </p>
                  <div className="choice-grid three">
                    {times.map((item) => (
                      <button
                        className="choice"
                        key={item.startsAt}
                        onClick={() => selectTime(item)}
                      >
                        {formatTime(item)}
                        <small>{durationMinutes} minutes</small>
                      </button>
                    ))}
                  </div>
                  <div className="inline-actions">
                    <button
                      className="secondary-button"
                      onClick={() => setStage("date")}
                    >
                      Change date
                    </button>
                  </div>
                </section>
              )}

              {stage === "review" && (
                <section className="inline-card" aria-label="Review appointment">
                  <span className="question-label">
                    Review your demo appointment
                  </span>
                  <h2>Almost there</h2>
                  <div className="review-list">
                    <div className="review-line">
                      <span>Visit</span>
                      <strong>
                        {specialtyLabel}
                        <br />
                        {specialist?.name}
                      </strong>
                    </div>
                    <div className="review-line">
                      <span>When</span>
                      <strong>
                        {formattedDate}
                        <br />
                        {formattedTime}
                      </strong>
                    </div>
                    <div className="review-line">
                      <span>Where</span>
                      <strong>
                        {location?.name}
                        <br />
                        {durationMinutes} minutes
                      </strong>
                    </div>
                  </div>
                  <div className="form-grid">
                    <label className="field full-field">
                      Display name
                      <input
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                        placeholder="How should we address you?"
                        required
                      />
                    </label>
                    <label className="field full-field">
                      Email <span className="visually-hidden">optional</span>
                      <input
                        type="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="Optional — no email will be sent"
                      />
                    </label>
                  </div>
                  <p>
                    No information leaves this browser. This creates a local demo
                    reservation only.
                  </p>
                  {confirmationError && (
                    <p className="form-error" role="alert">
                      {confirmationError}
                    </p>
                  )}
                  <div className="inline-actions">
                    <button
                      className="primary-button"
                      disabled={!displayName.trim()}
                      onClick={confirm}
                    >
                      Confirm appointment
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => setStage("time")}
                    >
                      Change time
                    </button>
                  </div>
                </section>
              )}

              {stage === "confirmed" && confirmedAppointment && (
                <section
                  className="inline-card confirmation"
                  aria-label="Appointment confirmed"
                >
                  <span className="card-eyebrow">
                    Local demo reservation confirmed
                  </span>
                  <h2>You’re all set, {displayName}.</h2>
                  <p>
                    Your {specialtyLabel} appointment is scheduled for{" "}
                    {formattedDate} at {formattedTime}. Keep this code for your
                    records.
                  </p>
                  <div className="confirmation-code">
                    {confirmedAppointment.confirmationCode}
                  </div>
                  <p>Nothing was sent to a clinic or email address.</p>
                  <button className="primary-button" onClick={newConversation}>
                    Start a new conversation
                  </button>
                </section>
              )}

              {stage === "urgent" && (
                <section
                  className="inline-card urgent"
                  role="alert"
                  aria-label="Urgent care guidance"
                >
                  <span className="card-eyebrow">Routine scheduling paused</span>
                  <h2>Please seek immediate care now</h2>
                  <p>
                    Your message may describe an urgent warning sign. Call local
                    emergency services or go to the nearest emergency department.
                    This scheduling guide cannot safely assess or schedule routine
                    care for this concern.
                  </p>
                  <button className="primary-button" onClick={newConversation}>
                    Start a new conversation
                  </button>
                </section>
              )}
            </div>
          </div>

          <div className="composer-wrap">
            <form className="composer" onSubmit={submitMessage}>
              <label className="visually-hidden" htmlFor="message">
                Describe your concern
              </label>
              <div className="composer-inner">
                <label className="icon-button" title="Attach symptom history">
                  <span aria-hidden="true">⌁</span>
                  <span className="visually-hidden">Attach symptom history</span>
                  <input
                    className="file-input"
                    type="file"
                    accept=".txt,.md,.json,.csv,.pdf,text/plain,text/markdown,application/json,text/csv,application/pdf"
                    onChange={handleAttachment}
                    disabled={!composerEnabled}
                  />
                </label>
                <textarea
                  id="message"
                  rows={1}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={
                    enhancementStatus === "checking"
                      ? "Checking your response…"
                      : composerEnabled
                      ? "Describe what’s going on…"
                      : stage === "urgent"
                        ? "Routine scheduling is paused"
                        : "Use the options above to continue"
                  }
                  disabled={!composerEnabled}
                />
                <button
                  className="send-button"
                  type="submit"
                  aria-label="Send message"
                  disabled={!composerEnabled || !draft.trim()}
                >
                  ↑
                </button>
              </div>
              <p className="composer-hint">
                Attach up to 5 MB of TXT, Markdown, JSON, or CSV history for local
                review. PDF is not yet supported.
              </p>
            </form>
          </div>
        </div>

        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
      </section>
    </main>
  );
}
