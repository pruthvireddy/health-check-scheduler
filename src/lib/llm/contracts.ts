import { z } from "zod";

import { conversationStageSchema, symptomEvidenceSchema } from "@/lib/validation/schemas";

export const SPECIALTY_IDS = [
  "primary-care",
  "cardiology",
  "dermatology",
  "gastroenterology",
  "neurology",
  "orthopedics",
  "ent",
] as const;

export const specialtyIdSchema = z.enum(SPECIALTY_IDS);

export const FOLLOW_UP_QUESTION_TYPES = [
  "onset",
  "duration",
  "severity",
  "progression",
  "associated_symptoms",
  "injury_context",
  "recurrence",
  "current_status",
] as const;

export const followUpQuestionTypeSchema = z.enum(FOLLOW_UP_QUESTION_TYPES);

export const ENHANCEMENT_PURPOSES = [
  "care_navigation",
  "scheduling_transition",
  "confirmation",
] as const;

export const enhancementPurposeSchema = z.enum(ENHANCEMENT_PURPOSES);

export const FOLLOW_UP_PROMPTS: Record<FollowUpQuestionType, string> = {
  onset: "When did these symptoms first begin?",
  duration: "How long do the symptoms last when they occur?",
  severity: "How severe are the symptoms on a scale from 1 to 10?",
  progression: "Are the symptoms improving, worsening, or staying about the same?",
  associated_symptoms: "Are you noticing any other symptoms at the same time?",
  injury_context: "Did this start after an injury, strain, or unusual activity?",
  recurrence: "Has this happened before, and if so, how often?",
  current_status: "Are the symptoms happening right now?",
};

export const retrievedSpecialtySchema = z.object({
  specialtyId: specialtyIdSchema,
  confidence: z.number().min(0).max(1),
  matchedTerms: z.array(z.string().trim().min(1).max(120)).max(4),
});

export const enhancementChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(2_000),
});

export const chatEnhancementRequestSchema = z.object({
  conversationId: z.string().trim().min(1).max(120),
  stage: conversationStageSchema,
  recentMessages: z.array(enhancementChatMessageSchema).min(1).max(8),
  approvedEvidence: z
    .array(symptomEvidenceSchema)
    .max(50)
    .transform((items) => items.filter((item) => item.userApproved && !item.negated)),
  retrievedCandidates: z.array(retrievedSpecialtySchema).default([]),
  answeredQuestionTypes: z.array(followUpQuestionTypeSchema).max(4),
  followUpCount: z.number().int().min(0).max(4),
  purpose: enhancementPurposeSchema.default("care_navigation"),
  transitionContext: z.string().trim().min(1).max(500).optional(),
});

export const modelEvidenceProposalSchema = z.object({
  normalizedTerm: z.string().trim().min(1).max(120),
  originalText: z.string().trim().min(1).max(500),
  temporality: z.enum(["current", "historical", "uncertain"]),
});

export const modelDecisionSchema = z
  .object({
    extractedEvidence: z.array(modelEvidenceProposalSchema).max(12),
    nextAction: z.enum([
      "ask_follow_up",
      "recommend_specialist",
      "urgent_review",
      "phase_transition",
    ]),
    questionType: followUpQuestionTypeSchema.optional(),
    specialtyId: specialtyIdSchema.optional(),
    confidence: z.number().min(0).max(1),
    conversationalLead: z.string().trim().min(1).max(180).optional(),
    explanation: z.string().trim().min(1).max(500).optional(),
  })
  .superRefine((decision, context) => {
    if (decision.nextAction === "ask_follow_up" && !decision.questionType) {
      context.addIssue({
        code: "custom",
        path: ["questionType"],
        message: "questionType is required when nextAction is ask_follow_up",
      });
    }

    if (decision.nextAction === "recommend_specialist" && !decision.specialtyId) {
      context.addIssue({
        code: "custom",
        path: ["specialtyId"],
        message: "specialtyId is required when nextAction is recommend_specialist",
      });
    }
  });

export const chatEnhancementResponseSchema = modelDecisionSchema.and(
  z.object({
    mode: z.enum(["llm", "synthetic_fallback"]),
    modelVersion: z.string().trim().min(1).max(200).optional(),
    fallbackReason: z.string().trim().min(1).max(240).optional(),
  }),
);

export type FollowUpQuestionType = z.infer<typeof followUpQuestionTypeSchema>;
export type EnhancementPurpose = z.infer<typeof enhancementPurposeSchema>;
export type EnhancementChatMessage = z.infer<typeof enhancementChatMessageSchema>;
export type ChatEnhancementRequest = z.input<typeof chatEnhancementRequestSchema>;
export type ParsedChatEnhancementRequest = z.output<typeof chatEnhancementRequestSchema>;
export type RetrievedSpecialtyCandidate = z.infer<typeof retrievedSpecialtySchema>;
export type ModelEvidenceProposal = z.infer<typeof modelEvidenceProposalSchema>;
export type ModelDecision = z.infer<typeof modelDecisionSchema>;
export type ChatEnhancementResponse = z.infer<typeof chatEnhancementResponseSchema>;

export function followUpPromptFor(questionType: FollowUpQuestionType): string {
  return FOLLOW_UP_PROMPTS[questionType];
}

export function syntheticFallbackResponse(reason: string): ChatEnhancementResponse {
  return {
    mode: "synthetic_fallback",
    extractedEvidence: [],
    nextAction: "ask_follow_up",
    questionType: "onset",
    confidence: 0,
    fallbackReason: reason.slice(0, 240),
  };
}
