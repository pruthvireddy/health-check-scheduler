import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path, { resolve } from "node:path";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const RAW_PATH = resolve(ROOT, "data/knowledge/raw/disease-symptom/Final_Augmented_dataset_Diseases_and_Symptoms.csv");
const CROSWALK_PATH = resolve(ROOT, "data/knowledge/curated/disease-to-specialty.v1.csv");
const OUTPUT_DIR = resolve(ROOT, "data/knowledge/processed/symptom-specialty");
const PACK_OUTPUT = resolve(OUTPUT_DIR, "knowledge-pack.v1.json");
const MANIFEST_OUTPUT = resolve(OUTPUT_DIR, "manifest.v1.json");
const SCHEMA_VERSION = "1.0.0";
const KNOWLEDGE_VERSION = "health-check-scheduler-hybrid-v1";

const ALLOWED_SPECIALTIES = new Set([
  "primary-care",
  "cardiology",
  "dermatology",
  "gastroenterology",
  "neurology",
  "orthopedics",
  "ent",
]);

const MIN_SYMPTOM_SUPPORT = 5;
const MAX_SYMPTOM_CANDIDATES = 4;
const MAX_EVIDENCE_EXAMPLES = 3;

function normalizeTerm(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function parseCsvRow(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      i += 1;
      continue;
    }

    if (!inQuotes && char === ",") {
      values.push(current.trim());
      current = "";
      i += 1;
      continue;
    }

    if (!inQuotes && (char === "\r" || char === "\n")) {
      i += 1;
      continue;
    }

    current += char;
    i += 1;
  }

  values.push(current.trim());
  return values;
}

function isPositive(value: string): boolean {
  const normalized = normalizeTerm(value);
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

async function readChecksum(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const digest = await new Promise<string>((resolveDigest, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveDigest(hash.digest("hex")));
    stream.on("error", reject);
  });
  return digest;
}

async function readCsvRows(filePath: string): Promise<string[][]> {
  const rows: string[][] = [];
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const line of lines) {
    if (!line.trim()) continue;
    rows.push(parseCsvRow(line));
  }

  return rows;
}

function loadCrosswalk(filePath: string): Map<string, Array<{ specialtyId: string; subspecialtyId?: string; confidence: number }>> {
  if (!existsSync(filePath)) {
    throw new Error(`Crosswalk file missing at ${filePath}`);
  }

  const rows = readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  if (!rows.length) {
    throw new Error(`Crosswalk file was empty: ${filePath}`);
  }

  const header = parseCsvRow(rows[0]);
  const headerIndex: Record<string, number> = {};
  header.forEach((column, index) => {
    headerIndex[normalizeTerm(column)] = index;
  });

  const diseaseIndex = headerIndex["disease"];
  const specialtyIndex = headerIndex["specialtyid"];
  const subSpecialtyIndex = headerIndex["subspecialtyid"];
  const confidenceIndex = headerIndex["confidence"];

  if (diseaseIndex === undefined || specialtyIndex === undefined) {
    throw new Error(`Crosswalk file missing required headers: ${filePath}`);
  }

  const map = new Map<string, Array<{ specialtyId: string; subspecialtyId?: string; confidence: number }>>();

  for (let i = 1; i < rows.length; i += 1) {
    const row = parseCsvRow(rows[i]);
    if (row.length < 2) continue;

    const disease = row[diseaseIndex];
    const specialtyId = row[specialtyIndex]?.toLowerCase()?.trim() as string;
    if (!disease || !specialtyId) continue;
    if (!ALLOWED_SPECIALTIES.has(specialtyId)) continue;

    const confidence = Math.max(0, Math.min(1, Number(row[confidenceIndex] ?? 1) || 1));
    const subspecialtyId = row[subSpecialtyIndex]?.trim();
    const normalizedDisease = normalizeTerm(disease);

    const existing = map.get(normalizedDisease) ?? [];
    existing.push({
      specialtyId,
      subspecialtyId: subspecialtyId || undefined,
      confidence,
    });
    existing.sort((a, b) => b.confidence - a.confidence);
    map.set(normalizedDisease, existing);
  }

  return map;
}

function createEmptyPack(rawSymptomCount: number): {
  pack: Record<string, {
    symptom: string;
    aliases: string[];
    candidates: Array<{ specialtyId: string; subspecialtyId?: string; score: number; supportEvidence: string[] }>;
  }>;
  symptomTotals: Map<string, number>;
  crosswalkDiseaseSet: Set<string>;
  specialtyTotals: Map<string, number>;
  specialtySymptomCounts: Map<string, Map<string, number>>;
  symptomExampleMap: Map<string, Map<string, string[]>>;
} {
  const pack: Record<string, {
    symptom: string;
    aliases: string[];
    candidates: Array<{ specialtyId: string; subspecialtyId?: string; score: number; supportEvidence: string[] }>;
  }> = {};

  return {
    pack,
    symptomTotals: new Map(),
    crosswalkDiseaseSet: new Set(),
    specialtyTotals: new Map(),
    specialtySymptomCounts: new Map(),
    symptomExampleMap: new Map(),
  };
}

async function main() {
  if (!existsSync(RAW_PATH)) {
    throw new Error(`Raw symptom dataset missing at ${RAW_PATH}`);
  }
  if (!existsSync(CROSWALK_PATH)) {
    throw new Error(`Specialty crosswalk missing at ${CROSWALK_PATH}`);
  }

  const crosswalk = loadCrosswalk(CROSWALK_PATH);

  const rows = await readCsvRows(RAW_PATH);
  if (!rows.length) {
    throw new Error("Raw dataset did not contain any rows.");
  }

  const header = rows[0];
  const symptomHeaders = header.slice(1).map(normalizeTerm);
  const diseaseIndex = 0;
  const rowData = rows.slice(1);
  const checksum = await readChecksum(RAW_PATH);

  const {
    pack,
    symptomTotals,
    crosswalkDiseaseSet,
    specialtyTotals,
    specialtySymptomCounts,
    symptomExampleMap,
  } = createEmptyPack(symptomHeaders.length);

  let totalRows = 0;
  let mappedRows = 0;

  for (const row of rowData) {
    if (row.length < header.length) continue;
    const disease = row[diseaseIndex];
    if (!disease) continue;
    totalRows += 1;

    const mappings = crosswalk.get(normalizeTerm(disease)) || [];
    if (!mappings.length) {
      continue;
    }

    mappedRows += 1;
    const normalizedDisease = normalizeTerm(disease);
    crosswalkDiseaseSet.add(normalizedDisease);

    for (const mapping of mappings) {
      const specialty = mapping.specialtyId;
      if (!ALLOWED_SPECIALTIES.has(specialty)) continue;
      specialtyTotals.set(specialty, (specialtyTotals.get(specialty) ?? 0) + 1);
    }

    const positives = new Map<number, string>();
    for (let columnIndex = 1; columnIndex < row.length; columnIndex += 1) {
      const rawValue = row[columnIndex];
      if (!isPositive(rawValue)) continue;
      const symptom = symptomHeaders[columnIndex - 1];
      if (!symptom) continue;

      positives.set(columnIndex - 1, symptom);
      symptomTotals.set(symptom, (symptomTotals.get(symptom) ?? 0) + mappings.length);

      for (const mapping of mappings) {
        const specialty = mapping.specialtyId;
        const table = specialtySymptomCounts.get(specialty) ?? new Map<string, number>();
        table.set(symptom, (table.get(symptom) ?? 0) + 1);
        specialtySymptomCounts.set(specialty, table);

        const evidenceTable = symptomExampleMap.get(`${specialty}:${symptom}`) ?? [];
        const normalizedRowDisease = normalizeTerm(disease);
        if (!evidenceTable.includes(normalizedRowDisease) && evidenceTable.length < MAX_EVIDENCE_EXAMPLES) {
          evidenceTable.push(normalizedRowDisease);
        }
        symptomExampleMap.set(`${specialty}:${symptom}`, evidenceTable);
      }
    }

    if (!positives.size) {
      // Keep sparse rows but they do not inform symptom routing.
      continue;
    }
  }

  const symptomIndex: Record<string, any> = {};
  let unmappedRows = Math.max(0, totalRows - mappedRows);
  let allSymptomEntries = 0;

  for (const [symptom, symptomTotal] of symptomTotals) {
    const candidateBuckets: Array<{
      specialtyId: string;
      subspecialtyId?: string;
      score: number;
      supportEvidence: string[];
    }> = [];

    for (const [specialty, countsBySymptom] of specialtySymptomCounts) {
      const count = countsBySymptom.get(symptom) ?? 0;
      if (!count || count < MIN_SYMPTOM_SUPPORT) continue;
      const specialtyTotal = Math.max(1, specialtyTotals.get(specialty) ?? 1);

      const precision = count / specialtyTotal;
      const recall = count / symptomTotal;
      const raw = 100 * (0.7 * precision + 0.3 * recall);
      const score = Math.max(10, Math.min(98, Math.round(raw)));
      if (!score) continue;

      candidateBuckets.push({
        specialtyId: specialty,
        score,
        supportEvidence: symptomExampleMap.get(`${specialty}:${symptom}`) ?? [],
      });
    }

    if (!candidateBuckets.length) continue;
    candidateBuckets.sort((a, b) => b.score - a.score);
    const topCandidates = candidateBuckets.slice(0, MAX_SYMPTOM_CANDIDATES);
    symptomIndex[symptom] = {
      symptom,
      aliases: [],
      candidates: topCandidates,
    };
    allSymptomEntries += 1;
  }

  const specialtyNames: Record<string, string> = {
    "primary-care": "primary care",
    cardiology: "cardiology",
    dermatology: "dermatology",
    gastroenterology: "gastroenterology",
    neurology: "neurology",
    orthopedics: "orthopedics",
    ent: "ear, nose and throat",
  };

  const pack = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      sourceFile: path.relative(ROOT, RAW_PATH),
      sourceChecksum: checksum,
      rowCount: totalRows,
      mappedRowCount: mappedRows,
      unmappedRowCount: unmappedRows,
      symptomCount: symptomHeaders.length,
    },
    crosswalk: {
      file: path.relative(ROOT, CROSWALK_PATH),
      mappedDiseaseCount: crosswalkDiseaseSet.size,
      unmappedDiseaseCount: Math.max(0, totalRows - crosswalkDiseaseSet.size),
      totalDiseaseLinks: [...crosswalk.values()].reduce((sum, rows) => sum + rows.length, 0),
    },
    specialties: specialtyNames,
    symptomIndex,
    aliases: {},
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(PACK_OUTPUT, `${JSON.stringify(pack)}\n`, "utf8");
  writeFileSync(
    MANIFEST_OUTPUT,
    JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        generatedBy: KNOWLEDGE_VERSION,
        generatedAt: pack.generatedAt,
        packFile: path.relative(ROOT, PACK_OUTPUT),
        totalRows,
        mappedRows,
        unmappedRows,
        symptomEntries: allSymptomEntries,
        specialties: Object.keys(specialtyNames).length,
        sourceChecksum: checksum,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(`knowledge pack generated at ${path.relative(ROOT, PACK_OUTPUT)}`);
  console.log(`rows: ${totalRows}, mapped: ${mappedRows}, unmapped: ${unmappedRows}`);
  console.log(`symptom entries: ${allSymptomEntries}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Knowledge pack generation failed");
  process.exitCode = 1;
});
