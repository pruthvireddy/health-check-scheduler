import { SYNTHETIC_CATALOG_VERSION } from "@/config";
import { syntheticMappings } from "./catalog";
import type { RoutingCandidate, RoutingInput, RoutingResult, SpecialtyId, SpecialtyRouter, SymptomEvidence } from "@/lib/core/types";

const TERM_ALIASES: Record<string, string> = {
  "heart racing": "palpitations",
  "rapid heartbeat": "palpitations",
  "stomach ache": "stomach pain",
  "tummy pain": "stomach pain",
  "skin rash": "rash",
  "ear ache": "ear pain",
  "migraine headache": "migraine"
};

const negated = (text: string, term: string) => new RegExp(`(?:no|not|without|denies)\\s+(?:[a-z]+\\s+){0,2}${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text);

/** Extracts only supported fixture terms and retains the user's original wording as evidence. */
export function normalizeSymptomEvidence(text: string, idPrefix = "symptom"): SymptomEvidence[] {
  const lower = text.toLowerCase().replace(/\s+/g, " ").trim();
  const terms = new Set(syntheticMappings.flatMap((mapping) => mapping.symptomTerms));
  const evidence: SymptomEvidence[] = [];
  for (const term of terms) {
    if (!lower.includes(term) || negated(lower, term)) continue;
    const normalizedTerm = TERM_ALIASES[term] ?? term;
    if (!evidence.some((item) => item.normalizedTerm === normalizedTerm)) {
      evidence.push({ id: `${idPrefix}-${evidence.length + 1}`, normalizedTerm, originalText: text, temporality: "current", source: "conversation", userApproved: true });
    }
  }
  return evidence;
}

export class SyntheticSpecialtyRouter implements SpecialtyRouter {
  readonly backend = "synthetic" as const;

  async route({ evidence }: RoutingInput): Promise<RoutingResult> {
    const eligible = evidence.filter((item) => item.userApproved && item.temporality !== "historical");
    const candidates = new Map<SpecialtyId, { score: number; evidenceIds: string[]; subspecialtyId?: string }>();
    for (const mapping of syntheticMappings) {
      if (!mapping.active) continue;
      const matches = eligible.filter((item) => mapping.symptomTerms.includes(item.normalizedTerm));
      if (!matches.length) continue;
      const prior = candidates.get(mapping.specialtyId) ?? { score: 0, evidenceIds: [], subspecialtyId: mapping.subspecialtyId };
      prior.score += mapping.weight * matches.length;
      prior.evidenceIds.push(...matches.map((item) => item.id));
      candidates.set(mapping.specialtyId, prior);
    }
    const ranked: RoutingCandidate[] = [...candidates.entries()]
      .map(([specialtyId, value]) => ({ specialtyId, subspecialtyId: value.subspecialtyId, confidence: Math.min(0.95, value.score / 100), evidenceIds: [...new Set(value.evidenceIds)] }))
      .sort((a, b) => b.confidence - a.confidence || a.specialtyId.localeCompare(b.specialtyId));
    return { backend: this.backend, version: SYNTHETIC_CATALOG_VERSION, candidates: ranked, provenanceIds: ranked.length ? ["synthetic-specialties"] : [] };
  }
}

export function createSyntheticSpecialtyRouter(): SpecialtyRouter {
  return new SyntheticSpecialtyRouter();
}
