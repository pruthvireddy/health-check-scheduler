import type { ExtractedSymptom } from "./types";
import type { EvidenceSource } from "@/lib/validation";

type SymptomDefinition = { term: string; patterns: RegExp[] };

const SYMPTOMS: SymptomDefinition[] = [
  { term: "chest pain", patterns: [/\bchest (?:pain|pressure|tightness)\b/i] },
  { term: "shortness of breath", patterns: [/\b(?:shortness of breath|trouble breathing|breathless)\b/i] },
  { term: "headache", patterns: [/\b(?:headache|head pain)\b/i] },
  { term: "dizziness", patterns: [/\b(?:dizz(?:y|iness)|lightheaded(?:ness)?)\b/i] },
  { term: "rash", patterns: [/\b(?:rash|hives?)\b/i] },
  { term: "abdominal pain", patterns: [/\b(?:abdominal|stomach|belly) pain\b/i] },
  { term: "nausea", patterns: [/\bnausea(?:ted)?\b/i] },
  { term: "vomiting", patterns: [/\b(?:vomit(?:ing|ed)?|throwing up)\b/i] },
  { term: "joint pain", patterns: [/\b(?:joint|knee|shoulder|hip|ankle|wrist) pain\b/i] },
  { term: "back pain", patterns: [/\b(?:lower |upper |mid )?back pain\b/i] },
  { term: "sore throat", patterns: [/\b(?:sore throat|throat pain)\b/i] },
  { term: "ear pain", patterns: [/\b(?:earache|ear pain)\b/i] },
  { term: "cough", patterns: [/\b(?:cough|coughing)\b/i] },
];

function stableId(seed: string): string {
  let hash = 5381;
  for (let index = 0; index < seed.length; index += 1) hash = (hash * 33) ^ seed.charCodeAt(index);
  return `e-${(hash >>> 0).toString(36)}`;
}

function temporalityFor(text: string, source: EvidenceSource): ExtractedSymptom["temporality"] {
  const window = text.toLowerCase();
  if (/\b(?:currently|current|now|today|ongoing|still|this (?:morning|week|month)|for \d+ (?:day|week|month))/i.test(window)) return "current";
  if (/\b(?:history of|histor(?:y|ical)|previous(?:ly)?|former(?:ly)?|last year|years? ago|resolved|in \d{4})\b/i.test(window)) return "historical";
  return source === "conversation" ? "current" : "uncertain";
}

function isNegated(text: string, offset: number): boolean {
  const preceding = text.slice(Math.max(0, offset - 48), offset);
  return /\b(?:no|not|without|denies?|never|negative for)\s+(?:\w+\s+){0,3}$/i.test(preceding);
}

/** Extracts a compact, reviewable set of ordinary symptom phrases without diagnosing. */
export function extractSymptomTerms(
  text: string,
  options: { source: EvidenceSource; sourceLabel?: string; idFactory?: () => string } = { source: "conversation" },
): ExtractedSymptom[] {
  const results: ExtractedSymptom[] = [];
  const seen = new Set<string>();

  for (const definition of SYMPTOMS) {
    for (const pattern of definition.patterns) {
      const match = pattern.exec(text);
      if (!match || match.index === undefined) continue;
      const originalText = match[0];
      const negated = isNegated(text, match.index);
      const key = `${definition.term}:${match.index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const nearby = text.slice(Math.max(0, match.index - 80), Math.min(text.length, match.index + originalText.length + 80));
      const id = options.idFactory?.() ?? stableId(`${options.source}:${options.sourceLabel ?? ""}:${definition.term}:${match.index}`);
      results.push({
        id,
        normalizedTerm: definition.term,
        originalText,
        temporality: temporalityFor(nearby, options.source),
        source: options.source,
        sourceLabel: options.sourceLabel,
        userApproved: false,
        negated,
      });
    }
  }

  return results;
}
