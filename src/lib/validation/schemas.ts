import { z } from "zod";

/** Limits are deliberately small because all parsing happens in the browser. */
export const CONTEXT_LIMITS = {
  maxFilesPerConversation: 5,
  maxFileBytes: 5 * 1024 * 1024,
  maxExtractedCharacters: 50_000,
} as const;

export const conversationStageSchema = z.enum([
  "welcome",
  "collecting_symptoms",
  "reviewing_context",
  "urgent_screening",
  "asking_follow_ups",
  "recommending_specialist",
  "selecting_location",
  "selecting_duration",
  "selecting_date",
  "selecting_time",
  "reviewing_appointment",
  "confirmed",
  "urgent_exit",
  "unsupported",
  "error_recovery",
  "cancelled",
]);

export const temporalitySchema = z.enum(["current", "historical", "uncertain"]);
export const evidenceSourceSchema = z.enum(["conversation", "context_file"]);

export const symptomEvidenceSchema = z.object({
  id: z.string().min(1),
  normalizedTerm: z.string().min(1).max(120),
  originalText: z.string().min(1).max(2_000),
  temporality: temporalitySchema,
  source: evidenceSourceSchema,
  sourceLabel: z.string().min(1).max(255).optional(),
  userApproved: z.boolean(),
  /** A negated fact is retained for review but must not be used for routing. */
  negated: z.boolean().optional(),
});

export const contextReviewSchema = z.object({
  id: z.string().min(1),
  sourceFileName: z.string().min(1).max(255),
  sourceType: z.enum(["txt", "md", "json", "csv"]),
  extractedAt: z.string().datetime(),
  evidence: z.array(symptomEvidenceSchema).max(100),
  approved: z.boolean(),
  approvedAt: z.string().datetime().optional(),
});

export const chatMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["assistant", "user", "system"]),
  text: z.string().min(1).max(10_000),
  createdAt: z.string().datetime(),
});

export const recommendationSchema = z.object({
  specialtyId: z.string().min(1),
  subspecialtyId: z.string().min(1).optional(),
  rationale: z.string().min(1).max(2_000),
  confidence: z.enum(["high", "medium", "fallback"]),
  evidenceIds: z.array(z.string().min(1)).max(250),
  catalogVersion: z.string().min(1),
  routingSource: z.object({
    backend: z.enum(["synthetic", "csv", "pretrained_model"]),
    version: z.string().min(1),
    provenanceIds: z.array(z.string().min(1)).max(100),
  }),
});

/** The portable, storage-safe portion of a chat session. No file bytes are stored. */
export const conversationRecordSchema = z.object({
  id: z.string().min(1),
  stage: conversationStageSchema,
  messages: z.array(chatMessageSchema).max(250),
  evidence: z.array(symptomEvidenceSchema).max(250),
  contextReviews: z.array(contextReviewSchema).max(CONTEXT_LIMITS.maxFilesPerConversation),
  followUpQuestionIds: z.array(z.string().min(1)).max(4).optional(),
  answeredFollowUpIds: z.array(z.string().min(1)).max(4).optional(),
  recommendation: recommendationSchema.optional(),
  selectedLocationId: z.string().min(1).optional(),
  selectedDurationMinutes: z.number().int().positive().max(480).optional(),
  selectedDate: z.string().date().optional(),
  selectedSlotStart: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const appointmentSchema = z.object({
  id: z.string().min(1),
  confirmationCode: z.string().min(1).max(32),
  conversationId: z.string().min(1),
  patientDisplayName: z.string().min(1).max(120),
  contactEmail: z.string().email().max(320).optional(),
  specialistId: z.string().min(1),
  locationId: z.string().min(1),
  durationMinutes: z.number().int().positive().max(480),
  startsAt: z.string().datetime(),
  timezone: z.string().min(1).max(100),
  status: z.enum(["confirmed", "cancelled"]),
  createdAt: z.string().datetime(),
});

export const persistenceMetadataSchema = z.object({
  schemaVersion: z.number().int().positive(),
  updatedAt: z.string().datetime(),
});

export type ConversationStage = z.infer<typeof conversationStageSchema>;
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;
export type SymptomEvidence = z.infer<typeof symptomEvidenceSchema>;
export type ContextReview = z.infer<typeof contextReviewSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type Recommendation = z.infer<typeof recommendationSchema>;
export type ConversationRecord = z.infer<typeof conversationRecordSchema>;
export type Appointment = z.infer<typeof appointmentSchema>;
export type PersistenceMetadata = z.infer<typeof persistenceMetadataSchema>;
