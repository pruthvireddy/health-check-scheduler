import { getLocation, getSpecialist } from "@/lib/adapters/deterministic";
import { isSlotAvailable } from "./availability";
import type { Appointment, AppointmentDraft, AvailableSlot } from "@/lib/core/types";

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateConfirmationCode(random: () => number = Math.random): string {
  let suffix = "";
  for (let index = 0; index < 6; index += 1) suffix += alphabet[Math.floor(random() * alphabet.length) % alphabet.length];
  return `HCS-${suffix}`;
}

export function createAppointment(draft: AppointmentDraft, existingAppointments: Appointment[] = [], now = new Date(), random: () => number = Math.random): Appointment {
  if (!draft.patientDisplayName.trim()) throw new Error("A display name is required to confirm a demo appointment.");
  const specialist = getSpecialist(draft.specialistId);
  const location = getLocation(draft.locationId);
  if (!specialist || !location) throw new Error("The selected specialist or location is unavailable.");
  const slot: AvailableSlot = { startsAt: draft.startsAt, endsAt: new Date(new Date(draft.startsAt).getTime() + draft.durationMinutes * 60_000).toISOString(), durationMinutes: draft.durationMinutes, specialistId: draft.specialistId, locationId: draft.locationId, timezone: draft.timezone };
  if (draft.timezone !== location.timezone || !isSlotAvailable(slot, existingAppointments, now)) throw new Error("That appointment time is no longer available.");
  return { ...draft, id: `appointment-${now.getTime()}-${Math.floor(random() * 1_000_000)}`, confirmationCode: generateConfirmationCode(random), status: "confirmed", createdAt: now.toISOString() };
}
