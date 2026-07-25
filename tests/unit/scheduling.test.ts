import { describe, expect, it } from "vitest";
import { createAppointment, generateConfirmationCode, getAvailableSlots } from "@/lib/core";

describe("seeded demo scheduling", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");

  it("generates compatible slots within the scheduling window", () => {
    const slots = getAvailableSlots({ specialistId: "derm-ross", locationId: "northside", durationMinutes: 20, now });
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((slot) => slot.specialistId === "derm-ross" && slot.locationId === "northside")).toBe(true);
  });

  it("filters overlapping locally confirmed appointments and creates readable codes", () => {
    const slots = getAvailableSlots({ specialistId: "derm-ross", locationId: "northside", durationMinutes: 20, now });
    const appointment = createAppointment({ conversationId: "conversation", patientDisplayName: "Taylor", specialistId: "derm-ross", locationId: "northside", durationMinutes: 20, startsAt: slots[0].startsAt, timezone: "America/New_York" }, [], now, () => 0.1);
    expect(appointment.confirmationCode).toMatch(/^HCS-[A-Z0-9]{6}$/);
    const remaining = getAvailableSlots({ specialistId: "derm-ross", locationId: "northside", durationMinutes: 20, now, appointments: [appointment] });
    expect(remaining.some((slot) => slot.startsAt === appointment.startsAt)).toBe(false);
    expect(generateConfirmationCode(() => 0)).toBe("HCS-AAAAAA");
  });
});
