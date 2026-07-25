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
  type SymptomEvidence,
} from "@/lib/core";
import {
  createSyntheticSpecialtyRouter,
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

export function ChatScheduler() {
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
  const transcriptRef = useRef<HTMLDivElement>(null);

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

  async function submitMessage(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !["intake", "followup-one", "followup-two"].includes(stage)) return;

    const combinedText = `${conversationText} ${text}`.trim();
    setConversationText(combinedText);
    setDraft("");
    addMessage("user", text);

    if (screenForUrgentRedFlags(text).isUrgent) {
      setStage("urgent");
      setAnnouncement("Urgent symptoms identified. Routine scheduling stopped.");
      return;
    }
    if (stage === "intake") {
      continueWith(
        "followup-one",
        "Thanks. When did this start, and is it getting better, worse, or staying about the same?",
      );
      return;
    }
    if (stage === "followup-one") {
      continueWith(
        "followup-two",
        "One more question: have you noticed any fever, injury, rash, numbness, or other changes that feel relevant?",
      );
      return;
    }

    try {
      const conversationEvidence = normalizeSymptomEvidence(
        combinedText,
        `${conversationId}-symptom`,
      );
      const routingEvidence = [
        ...conversationEvidence,
        ...approvedContextEvidence(contextFile),
      ];
      setEvidence(routingEvidence);
      const routing = await createSyntheticSpecialtyRouter().route({
        evidence: routingEvidence,
      });
      setRecommendation(recommendationFromRouting(routing));
      continueWith("recommendation", "I have enough to suggest a next step.");
    } catch {
      const routing = await createSyntheticSpecialtyRouter().route({ evidence: [] });
      setRecommendation(recommendationFromRouting(routing));
      continueWith(
        "recommendation",
        "I couldn’t match that to the small demo catalog, so I’m suggesting a general starting point.",
      );
    }
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

  function selectLocation(item: ClinicLocation) {
    setLocation(item);
    setDurationMinutes(null);
    setDate(null);
    setSlot(null);
    setStage("duration");
    setAnnouncement("Location selected. Choose appointment duration.");
  }

  function selectDuration(item: number) {
    setDurationMinutes(item);
    setDate(null);
    setSlot(null);
    setStage("date");
    setAnnouncement("Duration selected. Choose a date.");
  }

  function selectDate(item: DateChoice) {
    setDate(item);
    setSlot(null);
    setStage("time");
    setAnnouncement("Date selected. Choose an available time.");
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
    setLocation(null);
    setDurationMinutes(null);
    setDate(null);
    setSlot(null);
    setDisplayName("");
    setEmail("");
    setConfirmedAppointment(null);
    setConfirmationError("");
    setAnnouncement("New conversation started.");
  }

  function clearData() {
    browserPersistence.clearAll();
    setAppointments([]);
    newConversation();
    setAnnouncement("Local demo data cleared and a new conversation started.");
  }

  const composerEnabled = ["intake", "followup-one", "followup-two"].includes(stage);
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
                <span className="mode-badge">Local rules mode</span>
                <span>No model or CSV required</span>
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
                      <span className="card-eyebrow">Recommended next step</span>
                      <h2>{specialtyLabel}</h2>
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
                    {recommendation.rationale} This is a scheduling suggestion,
                    not a diagnosis.
                  </p>
                  <button
                    className="primary-button"
                    onClick={() => {
                      setStage("location");
                      setAnnouncement(
                        "Recommendation accepted. Choose a location.",
                      );
                    }}
                  >
                    Find an appointment
                  </button>
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
                        onClick={() => {
                          setSlot(item);
                          setStage("review");
                          setAnnouncement(
                            "Time selected. Review your appointment.",
                          );
                        }}
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
                    composerEnabled
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
