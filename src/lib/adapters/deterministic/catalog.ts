import fixture from "../../../../data/catalog/synthetic-specialties.json";
import schedule from "../../../../data/scheduling/seed-schedule.json";
import type { ClinicLocation, FollowUpQuestion, Specialist, SpecialtyId, SymptomSpecialtyMapping } from "@/lib/core/types";

type Fixture = { specialists: Specialist[]; questions: FollowUpQuestion[]; mappings: SymptomSpecialtyMapping[] };
type ScheduleFixture = { locations: ClinicLocation[] };

const typedFixture = fixture as unknown as Fixture;
const typedSchedule = schedule as unknown as ScheduleFixture;

export const syntheticSpecialists: readonly Specialist[] = typedFixture.specialists;
export const syntheticFollowUpQuestions: readonly FollowUpQuestion[] = typedFixture.questions;
export const syntheticMappings: readonly SymptomSpecialtyMapping[] = typedFixture.mappings;
export const seededLocations: readonly ClinicLocation[] = typedSchedule.locations;

export function getSpecialist(id: string): Specialist | undefined {
  return syntheticSpecialists.find((specialist) => specialist.id === id);
}

export function getSpecialistsForSpecialty(specialtyId: SpecialtyId): Specialist[] {
  return syntheticSpecialists.filter((specialist) => specialist.specialtyId === specialtyId);
}

export function getDefaultSpecialistForSpecialty(specialtyId: SpecialtyId, locationId?: string): Specialist | undefined {
  return getSpecialistsForSpecialty(specialtyId).find((specialist) => !locationId || specialist.locationIds.includes(locationId));
}

export function getCompatibleLocations(specialtyId: SpecialtyId): ClinicLocation[] {
  const ids = new Set(getSpecialistsForSpecialty(specialtyId).flatMap((specialist) => specialist.locationIds));
  return seededLocations.filter((location) => ids.has(location.id));
}

export function getSupportedDurations(specialtyId: SpecialtyId, locationId: string): number[] {
  return [...new Set(getSpecialistsForSpecialty(specialtyId).filter((specialist) => specialist.locationIds.includes(locationId)).flatMap((specialist) => specialist.durations))].sort((a, b) => a - b);
}

export function getLocation(id: string): ClinicLocation | undefined {
  return seededLocations.find((location) => location.id === id);
}

export function getFollowUpQuestion(id: string): FollowUpQuestion | undefined {
  return syntheticFollowUpQuestions.find((question) => question.id === id);
}
