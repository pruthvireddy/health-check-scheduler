import { CONTEXT_LIMITS, contextReviewSchema } from "@/lib/validation";
import { extractSymptomTerms } from "./symptoms";
import type {
  ContextExtractionFailure,
  ContextExtractionResult,
  ContextFile,
  ContextFileKind,
  ExtractContextOptions,
  SupportedContextType,
} from "./types";

const EXTENSIONS: Record<string, ContextFileKind> = {
  txt: "txt",
  text: "txt",
  md: "md",
  markdown: "md",
  json: "json",
  csv: "csv",
  pdf: "pdf",
};

const MIME_TYPES: Record<SupportedContextType | "pdf", string[]> = {
  txt: ["text/plain"],
  md: ["text/markdown", "text/x-markdown"],
  json: ["application/json", "text/json"],
  csv: ["text/csv", "application/csv", "application/vnd.ms-excel"],
  pdf: ["application/pdf"],
};

function typeFromName(name: string): ContextFileKind {
  const extension = name.trim().split(".").pop()?.toLowerCase();
  return (extension && EXTENSIONS[extension]) || "unsupported";
}

function failure(
  file: ContextFile,
  kind: ContextFileKind,
  code: ContextExtractionFailure["code"],
  message: string,
): ContextExtractionFailure {
  return { status: code === "pdf_not_supported" ? "unsupported" : "rejected", fileName: file.name, kind, code, message };
}

async function readBrowserText(file: ContextFile): Promise<string> {
  if (file.text) return file.text();
  if (typeof FileReader === "undefined") throw new Error("The browser cannot read this file.");
  if (!(file instanceof Blob)) throw new Error("File text reader is unavailable.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsText(file);
  });
}

function validateStructuredText(kind: SupportedContextType, text: string): string | undefined {
  if (kind === "json") {
    try {
      JSON.parse(text);
    } catch {
      return "The JSON file is not valid JSON.";
    }
  }
  if (kind === "csv" && !text.trim()) return "The CSV file is empty.";
  return undefined;
}

/**
 * Safely extracts a supported, text-based attachment in the browser. PDF is deliberately
 * reported as unsupported in this prototype rather than pretending image or encrypted PDFs
 * can be read locally.
 */
export async function extractContextFile(
  file: ContextFile,
  options: ExtractContextOptions = {},
): Promise<ContextExtractionResult> {
  const kind = typeFromName(file.name);
  if (kind === "unsupported") return failure(file, kind, "unsupported_type", "Use a TXT, Markdown, JSON, or CSV file.");
  if (!Number.isFinite(file.size) || file.size < 0) return failure(file, kind, "invalid_content", "This file has an invalid size.");
  if (file.size > CONTEXT_LIMITS.maxFileBytes) return failure(file, kind, "file_too_large", "Files must be 5 MB or smaller.");
  if (kind === "pdf") return failure(file, kind, "pdf_not_supported", "PDF extraction is not available in this prototype. Please upload a text export instead.");

  const declared = file.type?.toLowerCase().split(";")[0];
  if (declared && !MIME_TYPES[kind].includes(declared)) {
    return failure(file, kind, "type_mismatch", "The file type does not match its filename extension.");
  }

  let rawText: string;
  try {
    rawText = await readBrowserText(file);
  } catch {
    return failure(file, kind, "read_failed", "The browser could not read this file.");
  }
  const previousLength = options.extractedCharacters ?? 0;
  if (rawText.length + previousLength > CONTEXT_LIMITS.maxExtractedCharacters) {
    return failure(file, kind, "extraction_limit", "This upload would exceed the 50,000-character conversation limit.");
  }
  const structureError = validateStructuredText(kind, rawText);
  if (structureError) return failure(file, kind, "invalid_content", structureError);

  const timestamp = (options.now?.() ?? new Date()).toISOString();
  const id = options.idFactory?.() ?? `context-${timestamp}-${file.name}`;
  const evidence = extractSymptomTerms(rawText, { source: "context_file", sourceLabel: file.name });
  const review = contextReviewSchema.parse({
    id,
    sourceFileName: file.name,
    sourceType: kind,
    extractedAt: timestamp,
    evidence,
    approved: false,
  });
  return { status: "accepted", kind, rawText, review, warnings: evidence.length ? [] : ["No supported symptom terms were found; you can still add context manually."] };
}

export async function extractContextFiles(
  files: ContextFile[],
  options: Omit<ExtractContextOptions, "extractedCharacters"> = {},
): Promise<ContextExtractionResult[]> {
  const results: ContextExtractionResult[] = [];
  let extractedCharacters = 0;
  for (const [index, file] of files.entries()) {
    if (index >= CONTEXT_LIMITS.maxFilesPerConversation) {
      results.push(failure(file, typeFromName(file.name), "too_many_files", "Only five context files can be added to a conversation."));
      continue;
    }
    const result = await extractContextFile(file, { ...options, extractedCharacters });
    results.push(result);
    if (result.status === "accepted") extractedCharacters += result.rawText.length;
  }
  return results;
}
