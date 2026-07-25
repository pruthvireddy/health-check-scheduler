import type { SpecialtyId } from "@/lib/core/types";

export type PackCandidate = {
  specialtyId: SpecialtyId;
  subspecialtyId?: string;
  score: number;
  supportEvidence?: string[];
};

export type PackSymptomProfile = {
  symptom: string;
  aliases?: string[];
  candidates: PackCandidate[];
};

export type PackMetadata = {
  sourceFile: string;
  sourceChecksum?: string;
  rowCount: number;
  mappedRowCount: number;
  unmappedRowCount: number;
  symptomCount: number;
};

export type PackCrosswalkMetadata = {
  file: string;
  mappedDiseaseCount: number;
  unmappedDiseaseCount: number;
  totalDiseaseLinks: number;
};

export type SymptomSpecialtyKnowledgePack = {
  schemaVersion: string;
  generatedAt: string;
  source: PackMetadata;
  crosswalk: PackCrosswalkMetadata;
  specialties: Record<SpecialtyId, string>;
  symptomIndex: Record<string, PackSymptomProfile>;
  aliases: Record<string, string[]>;
};

