import { SYNTHETIC_CATALOG_VERSION } from "@/config";
import { syntheticMappings } from "./catalog";
import {
  createCompiledSpecialtyRouter,
  getCompiledSymptomTerms,
} from "./compiled-router";
import type {
  RoutingCandidate,
  RoutingInput,
  RoutingResult,
  SpecialtyId,
  SpecialtyRouter,
  SymptomEvidence,
} from "@/lib/core/types";

const TERM_ALIASES: Record<string, string> = {
  "heart racing": "palpitations",
  "rapid heartbeat": "palpitations",
  "stomach ache": "stomach pain",
  "tummy pain": "stomach pain",
  "skin rash": "rash",
  "ear ache": "ear pain",
  "migraine headache": "migraine",
};

const normalizeTerm = (value: string): string =>
  value.toLowerCase().replace(/\s+/g, " ").trim();

const negated = (text: string, term: string): boolean =>
  new RegExp(`(?:no|not|without|denies)\s+(?:[a-z]+\s+){0,2}${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text);

const SUPPORTED_SYMPTOM_TERMS = new Set<string>([
  ...syntheticMappings.flatMap((mapping) => mapping.symptomTerms),
  ...getCompiledSymptomTerms(),
]);

/** Extracts only supported fixture terms and retains the user's original wording as evidence. */
export function normalizeSymptomEvidence(
  text: string,
  idPrefix = "symptom",
): SymptomEvidence[] {
  const lower = normalizeTerm(text);
  const evidence: SymptomEvidence[] = [];

  for (const term of SUPPORTED_SYMPTOM_TERMS) {
    if (!lower.includes(term) || negated(lower, term)) continue;
    const normalizedTerm = TERM_ALIASES[term] ?? term;
    if (!evidence.some((item) => item.normalizedTerm === normalizedTerm)) {
      evidence.push({
        id: `${idPrefix}-${evidence.length + 1}`,
        normalizedTerm,
        originalText: text,
        temporality: "current",
        source: "conversation",
        userApproved: true,
      });
    }
  }

  return evidence;
}

export class SyntheticSpecialtyRouter implements SpecialtyRouter {
  readonly backend = "synthetic" as const;

  async route({ evidence }: RoutingInput): Promise<RoutingResult> {
    const eligible = evidence.filter(
      (item) => item.userApproved && item.temporality !== "historical",
    );
    const candidates = new Map<
      SpecialtyId,
      { score: number; evidenceIds: string[]; subspecialtyId?: string; matchedTerms: string[] }
    >();

    for (const mapping of syntheticMappings) {
      if (!mapping.active) continue;
      const matches = eligible.filter((item) =>
        mapping.symptomTerms.includes(item.normalizedTerm),
      );
      if (!matches.length) continue;

      const prior =
        candidates.get(mapping.specialtyId) ??
        { score: 0, evidenceIds: [], subspecialtyId: mapping.subspecialtyId, matchedTerms: [] };
      prior.score += mapping.weight * matches.length;
      prior.evidenceIds.push(...matches.map((item) => item.id));
      prior.matchedTerms.push(...matches.map((item) => item.normalizedTerm));
      candidates.set(mapping.specialtyId, prior);
    }

    const ranked: RoutingCandidate[] = [...candidates.entries()]
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
      version: SYNTHETIC_CATALOG_VERSION,
      candidates: ranked,
      provenanceIds: ranked.length ? ["synthetic-specialties"] : [],
    };
  }
}

export class HybridSpecialtyRouter implements SpecialtyRouter {
  private readonly compiledRouter = createCompiledSpecialtyRouter();
  private readonly syntheticRouter = createSyntheticSpecialtyRouter();

  async route({ evidence }: RoutingInput): Promise<RoutingResult> {
    const [compiledResult, syntheticResult] = await Promise.all([
      this.compiledRouter.route({ evidence }),
      this.syntheticRouter.route({ evidence }),
    ]);

    const merged = new Map<
      SpecialtyId,
      { score: number; evidenceIds: string[]; matchedTerms: string[]; subspecialtyId?: string }
    >();

    const addCandidate = (
      candidate: RoutingCandidate,
      sourceMultiplier: number,
    ): void => {
      const prior =
        merged.get(candidate.specialtyId) ??
        { score: 0, evidenceIds: [], matchedTerms: [], subspecialtyId: candidate.subspecialtyId };

      prior.score += Math.min(95, candidate.confidence * 100) * sourceMultiplier;
      prior.evidenceIds.push(...candidate.evidenceIds);
      prior.matchedTerms.push(...candidate.matchedTerms);

      if (!prior.subspecialtyId && candidate.subspecialtyId) {
        prior.subspecialtyId = candidate.subspecialtyId;
      }

      merged.set(candidate.specialtyId, prior);
    };

    compiledResult.candidates.forEach((candidate) => addCandidate(candidate, 1.2));
    syntheticResult.candidates.forEach((candidate) => addCandidate(candidate, 0.9));

    const ranked: RoutingCandidate[] = [...merged.entries()]
      .map(([specialtyId, value]) => ({
        specialtyId,
        subspecialtyId: value.subspecialtyId,
        confidence: Math.min(0.96, Math.max(0.1, value.score / 100)),
        evidenceIds: [...new Set(value.evidenceIds)],
        matchedTerms: [...new Set(value.matchedTerms)],
      }))
      .sort((a, b) => b.confidence - a.confidence || a.specialtyId.localeCompare(b.specialtyId));

    const provenanceIds = [...new Set([...compiledResult.provenanceIds, ...syntheticResult.provenanceIds])];
    return {
      backend:
        compiledResult.candidates.length > 0
          ? "csv"
          : syntheticResult.candidates.length > 0
            ? "synthetic"
            : "csv",
      version:
        compiledResult.candidates.length > 0
          ? compiledResult.version
          : syntheticResult.version,
      candidates: ranked,
      provenanceIds,
    };
  }
}

export function createSyntheticSpecialtyRouter(): SpecialtyRouter {
  return new SyntheticSpecialtyRouter();
}

export function createHybridSpecialtyRouter(): SpecialtyRouter {
  return new HybridSpecialtyRouter();
}

