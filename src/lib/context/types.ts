import type { ContextReview, SymptomEvidence } from "@/lib/validation";

export type SupportedContextType = "txt" | "md" | "json" | "csv";
export type ContextFileKind = SupportedContextType | "pdf" | "unsupported";

/** The subset of File used by the local extractor, making it easy to test. */
export interface ContextFile {
  name: string;
  size: number;
  type?: string;
  text?: () => Promise<string>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}

export interface ContextExtractionSuccess {
  status: "accepted";
  kind: SupportedContextType;
  /** Raw text is intentionally in-memory only and must never be persisted. */
  rawText: string;
  review: ContextReview;
  warnings: string[];
}

export interface ContextExtractionFailure {
  status: "rejected" | "unsupported";
  fileName: string;
  kind: ContextFileKind;
  code:
    | "too_many_files"
    | "file_too_large"
    | "unsupported_type"
    | "type_mismatch"
    | "pdf_not_supported"
    | "read_failed"
    | "invalid_content"
    | "extraction_limit";
  message: string;
}

export type ContextExtractionResult = ContextExtractionSuccess | ContextExtractionFailure;

export interface ExtractContextOptions {
  /** Existing extracted character count from the conversation. */
  extractedCharacters?: number;
  now?: () => Date;
  idFactory?: () => string;
}

export interface ExtractedSymptom extends SymptomEvidence {
  negated: boolean;
}
