import { EMERGENCY_GUIDANCE } from "@/config";
import type { UrgentScreeningResult } from "@/lib/core/types";

type RedFlagRule = { category: string; phrases: string[] };

// Deliberately small, conservative demo screen. It is not clinical triage or diagnosis.
const RED_FLAG_RULES: RedFlagRule[] = [
  { category: "severe breathing difficulty", phrases: ["cannot breathe", "can't breathe", "trouble breathing", "severe shortness of breath", "gasping for air"] },
  { category: "possible stroke symptoms", phrases: ["face drooping", "arm weakness", "slurred speech", "sudden weakness on one side", "sudden trouble speaking"] },
  { category: "severe or persistent chest pain", phrases: ["severe chest pain", "persistent chest pain", "chest pressure", "crushing chest pain", "chest pain that won't stop"] },
  { category: "loss of consciousness or acute confusion", phrases: ["passed out", "fainted", "loss of consciousness", "sudden confusion", "not making sense"] },
  { category: "uncontrolled bleeding", phrases: ["uncontrolled bleeding", "bleeding won't stop", "soaking through bandages", "vomiting blood"] },
  { category: "severe allergic reaction", phrases: ["throat closing", "swelling of lips", "swelling of tongue", "severe allergic reaction", "anaphylaxis"] },
  { category: "immediate self-harm risk", phrases: ["want to kill myself", "want to hurt myself", "suicide plan", "end my life"] }
];

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();

/** Screens only the newly reported, current symptom text; historical records must be confirmed as current separately. */
export function screenForUrgentRedFlags(text: string): UrgentScreeningResult {
  const normalized = normalize(text);
  for (const rule of RED_FLAG_RULES) {
    const matchedPhrases = rule.phrases.filter((phrase) => normalized.includes(phrase));
    if (matchedPhrases.length) {
      return { isUrgent: true, category: rule.category, matchedPhrases, guidance: EMERGENCY_GUIDANCE };
    }
  }
  return { isUrgent: false, matchedPhrases: [] };
}

export const emergencyWarningRules = RED_FLAG_RULES.map((rule) => ({ ...rule, phrases: [...rule.phrases] }));
