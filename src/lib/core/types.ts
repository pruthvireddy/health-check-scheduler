export type ConversationStage =
  | "welcome"
  | "collecting_symptoms"
  | "reviewing_context"
  | "urgent_screening"
  | "asking_follow_ups"
  | "recommending_specialist"
  | "selecting_location"
  | "selecting_duration"
  | "selecting_date"
  | "selecting_time"
  | "reviewing_appointment"
  | "confirmed"
  | "urgent_exit"
  | "unsupported"
  | "error_recovery"
  | "cancelled";

export type SpecialtyId =
  | "primary-care"
  | "cardiology"
  | "dermatology"
  | "gastroenterology"
  | "neurology"
  | "orthopedics"
  | "ent";

export type RoutingBackend = "synthetic" | "llm" | "csv" | "pretrained_model";

export type SymptomEvidence = {
  id: string;
  normalizedTerm: string;
  originalText: string;
  temporality: "current" | "historical" | "uncertain";
  source: "conversation" | "context_file";
  sourceLabel?: string;
  userApproved: boolean;
};

export type FollowUpQuestion = {
  id: string;
  specialtyId?: SpecialtyId;
  prompt: string;
  requiredTerms?: string[];
};

export type SymptomSpecialtyMapping = {
  version: 1;
  mappingId: string;
  symptomTerms: string[];
  specialtyId: SpecialtyId;
  subspecialtyId?: string;
  weight: number;
  followUpQuestionIds: string[];
  exclusionTerms: string[];
  rationaleTemplate?: string;
  active: boolean;
};

export type RoutingCandidate = {
  specialtyId: SpecialtyId;
  subspecialtyId?: string;
  confidence: number;
  evidenceIds: string[];
};

export type RoutingResult = {
  backend: RoutingBackend;
  version: string;
  candidates: RoutingCandidate[];
  provenanceIds: string[];
};

export type Recommendation = {
  specialtyId: SpecialtyId;
  subspecialtyId?: string;
  rationale: string;
  confidence: "high" | "medium" | "fallback";
  evidenceIds: string[];
  catalogVersion: string;
  routingSource: {
    backend: RoutingBackend;
    version: string;
    provenanceIds: string[];
  };
};

export type UrgentScreeningResult = {
  isUrgent: boolean;
  category?: string;
  matchedPhrases: string[];
  guidance?: string;
};

export type ChatAction =
  | { type: "ask_follow_up"; questionId: string }
  | { type: "review_context"; evidence: SymptomEvidence[] }
  | { type: "show_recommendation"; recommendation: Recommendation }
  | { type: "show_urgent_guidance"; category: string }
  | { type: "start_scheduling"; specialtyId: SpecialtyId }
  | { type: "recoverable_error"; message: string };

export type ConversationState = {
  id: string;
  stage: ConversationStage;
  evidence: SymptomEvidence[];
  followUpQuestionIds: string[];
  answeredFollowUpIds: string[];
  recommendation?: Recommendation;
  urgentResult?: UrgentScreeningResult;
  selectedLocationId?: string;
  selectedDurationMinutes?: number;
  selectedDate?: string;
  selectedSlotStart?: string;
};

export type ConversationProgress = {
  state: ConversationState;
  message: string;
  action?: ChatAction;
};

export type RoutingInput = { evidence: SymptomEvidence[] };

export interface SpecialtyRouter {
  readonly backend: RoutingBackend;
  route(input: RoutingInput): Promise<RoutingResult>;
}

export type Specialist = {
  id: string;
  specialtyId: SpecialtyId;
  subspecialtyId?: string;
  name: string;
  title: string;
  locationIds: string[];
  durations: number[];
};

export type ClinicLocation = {
  id: string;
  name: string;
  address: string;
  timezone: string;
  hours: Record<number, { start: string; end: string }>;
  blackoutDates: string[];
};

export type Appointment = {
  id: string;
  confirmationCode: string;
  conversationId: string;
  patientDisplayName: string;
  contactEmail?: string;
  specialistId: string;
  locationId: string;
  durationMinutes: number;
  startsAt: string;
  timezone: string;
  status: "confirmed" | "cancelled";
  createdAt: string;
};

export type AppointmentDraft = Omit<Appointment, "id" | "confirmationCode" | "createdAt" | "status">;

export type AvailableSlot = {
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  specialistId: string;
  locationId: string;
  timezone: string;
};
