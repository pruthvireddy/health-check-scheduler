import pack from "../../../../data/knowledge/processed/symptom-specialty/knowledge-pack.v1.json";

import { SYNTHETIC_CATALOG_VERSION } from "@/config";
import type { SymptomSpecialtyKnowledgePack } from "@/lib/knowledge/types";
import type {
  RoutingCandidate,
  RoutingInput,
  RoutingResult,
  SpecialtyId,
  SpecialtyRouter,
  SymptomEvidence,
} from "@/lib/core/types";

function normalizeSymptomTerm(value: string): string {
  return value.toLowerCase().normalize("NFKC").trim().replace(/\s+/g, " ");
}

type PackSymptomProfile = SymptomSpecialtyKnowledgePack["symptomIndex"][string];

const knowledgePack = pack as unknown as SymptomSpecialtyKnowledgePack;

function getCandidateProfile(term: string): PackSymptomProfile | undefined {
  const normalized = normalizeSymptomTerm(term);
  const direct = knowledgePack.symptomIndex?.[normalized];
  if (direct) return direct;

  for (const [canonical, aliases] of Object.entries(
    knowledgePack.aliases ?? {},
  )) {
    if (aliases.includes(normalized)) {
      return knowledgePack.symptomIndex?.[normalizeSymptomTerm(canonical)] as
        | PackSymptomProfile
        | undefined;
    }
  }

  return undefined;
}

function mapTermSet() {
  const terms = new Set<string>(Object.keys(knowledgePack.symptomIndex ?? {}));
  for (const aliases of Object.values(knowledgePack.aliases ?? {})) {
    aliases.forEach((alias) => {
      const normalized = normalizeSymptomTerm(alias);
      if (normalized) terms.add(normalized);
    });
  }
  return terms;
}

const KNOWN_SYMPTOM_TERMS = mapTermSet();

export function getCompiledSymptomTerms(): string[] {
  return [...KNOWN_SYMPTOM_TERMS];
}

export class CompiledSpecialtyRouter implements SpecialtyRouter {
  readonly backend = "csv" as const;

  async route({ evidence }: RoutingInput): Promise<RoutingResult> {
    const eligible = evidence.filter(
      (item) => item.userApproved && item.temporality !== "historical",
    );
    const candidateMap = new Map<
      SpecialtyId,
      { score: number; evidenceIds: string[]; matchedTerms: string[]; subspecialtyId?: string }
    >();

    for (const item of eligible) {
      const profile = getCandidateProfile(item.normalizedTerm);
      if (!profile?.candidates?.length) continue;

      for (const candidate of profile.candidates) {
        if (!candidate.subspecialtyId) {
          const current =
            candidateMap.get(candidate.specialtyId as SpecialtyId) ?? {
              score: 0,
              evidenceIds: [],
              matchedTerms: [],
            };

          current.score += Math.max(0, Math.min(100, candidate.score));
          if (!current.evidenceIds.includes(item.id)) current.evidenceIds.push(item.id);
          if (!current.matchedTerms.includes(item.normalizedTerm)) {
            current.matchedTerms.push(item.normalizedTerm);
          }
          candidateMap.set(candidate.specialtyId as SpecialtyId, current);
        }
      }
    }

    const candidates = [...candidateMap.entries()]
      .map(([specialtyId, value]) => ({
        specialtyId,
        subspecialtyId: value.subspecialtyId,
        confidence: Math.min(0.95, value.score / 100),
        evidenceIds: [...new Set(value.evidenceIds)],
        matchedTerms: [...new Set(value.matchedTerms)],
      }))
      .sort((a, b) => b.confidence - a.confidence || a.specialtyId.localeCompare(b.specialtyId));

    return {
      backend: this.backend,
      version: knowledgePack.schemaVersion ?? SYNTHETIC_CATALOG_VERSION,
      candidates,
      provenanceIds: candidates.length ? ["symptom-specialty-pack"] : ["symptom-specialty-pack-empty"],
    };
  }
}

export function createCompiledSpecialtyRouter(): SpecialtyRouter {
  return new CompiledSpecialtyRouter();
}
