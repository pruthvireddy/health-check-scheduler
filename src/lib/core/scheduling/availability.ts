import { SCHEDULING_WINDOW_DAYS } from "@/config";
import { getLocation, getSpecialist } from "@/lib/adapters/deterministic";
import type { Appointment, AvailableSlot } from "@/lib/core/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const clockMinutes = (clock: string) => {
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
};
const atLocalTime = (date: Date, minutes: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minutes / 60), minutes % 60, 0, 0);
const overlaps = (start: Date, end: Date, appointment: Appointment) => {
  if (appointment.status !== "confirmed") return false;
  const existingStart = new Date(appointment.startsAt);
  const existingEnd = new Date(existingStart.getTime() + appointment.durationMinutes * 60_000);
  return start < existingEnd && end > existingStart;
};

export type SlotQuery = {
  specialistId: string;
  locationId: string;
  durationMinutes: number;
  appointments?: Appointment[];
  now?: Date;
  days?: number;
};

/** Builds fictional local availability for the next 30 calendar days. */
export function getAvailableSlots(query: SlotQuery): AvailableSlot[] {
  const specialist = getSpecialist(query.specialistId);
  const location = getLocation(query.locationId);
  if (!specialist || !location || !specialist.locationIds.includes(location.id) || !specialist.durations.includes(query.durationMinutes)) return [];
  const now = query.now ? new Date(query.now) : new Date();
  const appointments = query.appointments ?? [];
  const slots: AvailableSlot[] = [];
  const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let offset = 0; offset < (query.days ?? SCHEDULING_WINDOW_DAYS); offset += 1) {
    const day = new Date(startDay.getTime() + offset * DAY_MS);
    const hours = location.hours[day.getDay()];
    if (!hours || location.blackoutDates.includes(dateKey(day))) continue;
    const earliest = clockMinutes(hours.start);
    const closing = clockMinutes(hours.end);
    for (let minute = earliest; minute + query.durationMinutes <= closing; minute += 30) {
      const start = atLocalTime(day, minute);
      const end = new Date(start.getTime() + query.durationMinutes * 60_000);
      if (start <= now || appointments.some((appointment) => appointment.specialistId === specialist.id && appointment.locationId === location.id && overlaps(start, end, appointment))) continue;
      slots.push({ startsAt: start.toISOString(), endsAt: end.toISOString(), durationMinutes: query.durationMinutes, specialistId: specialist.id, locationId: location.id, timezone: location.timezone });
    }
  }
  return slots;
}

export function isSlotAvailable(slot: AvailableSlot, appointments: Appointment[], now = new Date()): boolean {
  if (new Date(slot.startsAt) <= now) return false;
  return getAvailableSlots({ specialistId: slot.specialistId, locationId: slot.locationId, durationMinutes: slot.durationMinutes, appointments, now }).some((candidate) => candidate.startsAt === slot.startsAt);
}
