import { SYNTHETIC_CATALOG_VERSION } from "@/config";
import type { Recommendation, RoutingResult, SpecialtyId } from "@/lib/core/types";

const NAMES: Record<SpecialtyId, string> = {
  "primary-care": "primary care",
  cardiology: "cardiology",
  dermatology: "dermatology",
  gastroenterology: "gastroenterology",
  neurology: "neurology",
  orthopedics: "orthopedics",
  ent: "ear, nose, and throat care"
};

/** Produces a scheduling recommendation only; it does not diagnose or rule out conditions. */
export function recommendationFromRouting(result: RoutingResult): Recommendation {
  const best = result.candidates[0];
  if (!best || best.confidence < 0.55) {
    return {
      specialtyId: "primary-care",
      rationale: "Your concerns do not clearly match one curated specialty in this demo. A primary care visit is a good place to start.",
      confidence: "fallback",
      evidenceIds: [],
      catalogVersion: SYNTHETIC_CATALOG_VERSION,
      routingSource: { backend: result.backend, version: result.version, provenanceIds: result.provenanceIds }
    };
  }
  const confidence = best.confidence >= 0.75 ? "high" : "medium";
  return {
    specialtyId: best.specialtyId,
    subspecialtyId: best.subspecialtyId,
    rationale: `Based on the concerns you shared, ${NAMES[best.specialtyId]} may be a suitable place to start. This is a scheduling suggestion, not a diagnosis.`,
    confidence,
    evidenceIds: best.evidenceIds,
    catalogVersion: SYNTHETIC_CATALOG_VERSION,
    routingSource: { backend: result.backend, version: result.version, provenanceIds: result.provenanceIds }
  };
}
