import { describe, expect, it } from "vitest";
import {
  approveContextReview,
  approvedEvidence,
  extractContextFile,
  extractContextFiles,
} from "@/lib/context";
import { createBrowserPersistence, type StorageLike } from "@/lib/persistence";
import type { Appointment, ConversationRecord } from "@/lib/validation";
import { currentSymptomNote, historicalSymptomNote } from "../fixtures/context-files";

const now = () => new Date("2026-01-02T03:04:05.000Z");

class TestStorage implements StorageLike {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const conversation = (): ConversationRecord => ({
  id: "conversation-1",
  stage: "collecting_symptoms",
  messages: [{ id: "message-1", role: "user", text: "I have a rash", createdAt: now().toISOString() }],
  evidence: [],
  contextReviews: [],
  createdAt: now().toISOString(),
  updatedAt: now().toISOString(),
});

const appointment = (): Appointment => ({
  id: "appointment-1",
  confirmationCode: "HCS-7K4P92",
  conversationId: "conversation-1",
  patientDisplayName: "Demo User",
  specialistId: "dermatology",
  locationId: "downtown",
  durationMinutes: 30,
  startsAt: "2026-02-03T13:00:00.000Z",
  timezone: "America/New_York",
  status: "confirmed",
  createdAt: now().toISOString(),
});

describe("local context extraction", () => {
  it("extracts reviewable historical facts without approving them", async () => {
    const result = await extractContextFile(
      { name: "visit-summary.txt", size: historicalSymptomNote.length, type: "text/plain", text: async () => historicalSymptomNote },
      { now },
    );

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.review.approved).toBe(false);
    expect(result.review.evidence.map((fact) => fact.normalizedTerm)).toEqual(expect.arrayContaining(["rash", "headache"]));
    expect(result.review.evidence.every((fact) => fact.temporality === "historical")).toBe(true);
    expect(approvedEvidence([result.review])).toEqual([]);
    expect(approvedEvidence([approveContextReview(result.review, now().toISOString())])).toHaveLength(result.review.evidence.length);
  });

  it("rejects PDFs explicitly and preserves individual results when the file cap is exceeded", async () => {
    const pdf = await extractContextFile({ name: "note.pdf", size: 12, type: "application/pdf", text: async () => "not parsed" });
    expect(pdf).toMatchObject({ status: "unsupported", code: "pdf_not_supported" });

    const files = Array.from({ length: 6 }, (_, index) => ({
      name: `note-${index}.txt`, size: currentSymptomNote.length, type: "text/plain", text: async () => currentSymptomNote,
    }));
    const results = await extractContextFiles(files, { now });
    expect(results).toHaveLength(6);
    expect(results[5]).toMatchObject({ status: "rejected", code: "too_many_files" });
  });
});

describe("browser persistence", () => {
  it("round-trips validated records and safely discards corrupt entries", () => {
    const storage = new TestStorage();
    const persistence = createBrowserPersistence(storage);
    persistence.saveConversation(conversation());
    persistence.saveAppointment(appointment());
    expect(persistence.loadCurrentConversation()?.id).toBe("conversation-1");
    expect(persistence.getAppointment("appointment-1")?.confirmationCode).toBe("HCS-7K4P92");

    persistence.clearSymptomContext();
    expect(persistence.loadCurrentConversation()?.contextReviews).toEqual([]);

    storage.setItem("health-check-scheduler:v1:appointments", "not-json");
    expect(persistence.loadAppointments()).toEqual([]);
  });

  it("falls back to an in-memory session when storage writes fail", () => {
    const unavailable: StorageLike = {
      getItem: () => null,
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    const persistence = createBrowserPersistence(unavailable);
    persistence.saveConversation(conversation());
    expect(persistence.mode).toBe("memory");
    expect(persistence.loadCurrentConversation()?.id).toBe("conversation-1");
    persistence.clearAll();
    expect(persistence.loadCurrentConversation()).toBeUndefined();
  });

  it("does not use records marked with an incompatible schema version", () => {
    const storage = new TestStorage();
    storage.setItem("health-check-scheduler:metadata", JSON.stringify({ schemaVersion: 2, updatedAt: now().toISOString() }));
    storage.setItem("health-check-scheduler:v1:current-conversation", JSON.stringify(conversation()));
    expect(createBrowserPersistence(storage).loadCurrentConversation()).toBeUndefined();
  });
});
